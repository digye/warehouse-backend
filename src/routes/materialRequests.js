import { Router } from 'express';
import { pool } from '../db/pool.js';
import { sendMaterialRequestEmail } from '../utils/mailer.js';
import { requireAuth, requireRole } from '../middleware/auth.js';

const router = Router();

// Looks up how much of one product is in stock. If the request's warehouse name
// matches a real warehouse, only that warehouse's stock counts; otherwise all stock counts.
async function findStock(db, productId, warehouseName, { lock = false } = {}) {
  const wh = await db.query(
    'SELECT warehouse_id FROM warehouses WHERE lower(name) = lower(trim($1))',
    [warehouseName]
  );
  const scoped = wh.rows.length > 0;

  const params = [productId];
  let filter = '';
  if (scoped) {
    params.push(wh.rows.map((w) => w.warehouse_id));
    filter = 'AND l.warehouse_id = ANY($2)';
  }

  const rows = await db.query(
    `SELECT i.inventory_id, i.location_id, i.quantity
     FROM inventory i
     JOIN locations l ON l.location_id = i.location_id
     WHERE i.product_id = $1 AND i.quantity > 0 ${filter}
     ORDER BY i.quantity DESC
     ${lock ? 'FOR UPDATE OF i' : ''}`,
    params
  );

  return { rows: rows.rows, scope: scoped ? 'warehouse' : 'all' };
}

// Adds a stock availability summary to each item of a pending request
async function withAvailability(db, request) {
  if (request.status !== 'sent') return request;

  const items = [];
  for (const item of request.items) {
    if (!item.product_id) {
      items.push({ ...item, availability: { product_found: false, available: 0, sufficient: false } });
      continue;
    }
    const stock = await findStock(db, item.product_id, request.warehouse_name);
    const available = stock.rows.reduce((sum, r) => sum + r.quantity, 0);
    items.push({
      ...item,
      availability: {
        product_found: true,
        available,
        sufficient: available >= item.quantity,
        scope: stock.scope,
      },
    });
  }
  return { ...request, items };
}

// GET /material-requests/items - public list of products for the request form dropdown.
// Only names, SKUs and units are exposed here, never quantities or locations.
router.get('/items', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT product_id, name, sku, unit_of_measure FROM products ORDER BY name'
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /material-requests - the manager's list, each with its line items and a live stock check
router.get('/', requireAuth, async (req, res) => {
  try {
    const headers = await pool.query(
      'SELECT * FROM material_requests ORDER BY created_at DESC'
    );
    const itemRows = await pool.query(
      `SELECT * FROM material_request_items
       WHERE request_id = ANY($1) ORDER BY request_item_id`,
      [headers.rows.map((h) => h.request_id)]
    );

    const byRequest = {};
    for (const item of itemRows.rows) {
      (byRequest[item.request_id] ??= []).push(item);
    }

    const requests = [];
    for (const h of headers.rows) {
      const withItems = { ...h, items: byRequest[h.request_id] || [] };
      requests.push(await withAvailability(pool, withItems));
    }
    res.json(requests);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /material-requests/:id/approve - deducts stock for every item, all or nothing
router.post('/:id/approve', requireAuth, requireRole('admin'), async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const found = await client.query(
      'SELECT * FROM material_requests WHERE request_id = $1 FOR UPDATE',
      [req.params.id]
    );
    const request = found.rows[0];
    if (!request) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Request not found' });
    }
    if (request.status !== 'sent') {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: `This request was already ${request.status}` });
    }

    const itemsRes = await client.query(
      'SELECT * FROM material_request_items WHERE request_id = $1',
      [request.request_id]
    );
    const items = itemsRes.rows;
    if (!items.length) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'This request has no items to approve' });
    }

    // Re-check every item's stock now, with rows locked, before deducting anything
    for (const item of items) {
      if (!item.product_id) {
        await client.query('ROLLBACK');
        return res.status(400).json({
          error: `"${item.item_name}" is no longer a recognized product, so stock can't be deducted`,
        });
      }
      const stock = await findStock(client, item.product_id, request.warehouse_name, { lock: true });
      const available = stock.rows.reduce((sum, r) => sum + r.quantity, 0);
      if (available < item.quantity) {
        await client.query('ROLLBACK');
        return res.status(400).json({
          error: `Only ${available} of "${item.item_name}" in stock, but ${item.quantity} requested`,
        });
      }
      item._stockRows = stock.rows; // carry forward so we don't re-query after the check
    }

    // All items confirmed available - now actually deduct, taking from fullest locations first
    for (const item of items) {
      let remaining = item.quantity;
      for (const row of item._stockRows) {
        if (remaining <= 0) break;
        const take = Math.min(row.quantity, remaining);
        await client.query(
          'UPDATE inventory SET quantity = quantity - $1, last_updated = now() WHERE inventory_id = $2',
          [take, row.inventory_id]
        );
        await client.query(
          `INSERT INTO stock_movements
             (product_id, from_location_id, to_location_id, quantity, user_id, reason)
           VALUES ($1, $2, NULL, $3, $4, $5)`,
          [item.product_id, row.location_id, take, req.user.user_id,
           `material request #${request.request_id}`]
        );
        remaining -= take;
      }
    }

    // Approving a request fulfills it immediately (stock is already deducted above),
    // so it's recorded as a completed order rather than a pending one.
    const orderRes = await client.query(
      `INSERT INTO orders (customer_or_destination, status, order_date)
       VALUES ($1, 'fulfilled', CURRENT_DATE) RETURNING order_id`,
      [`Maintenance request — ${request.requester_name} (${request.warehouse_name})`]
    );
    const orderId = orderRes.rows[0].order_id;

    for (const item of items) {
      await client.query(
        `INSERT INTO order_items (order_id, product_id, quantity) VALUES ($1, $2, $3)`,
        [orderId, item.product_id, item.quantity]
      );
    }

    await client.query(
      `UPDATE material_requests
       SET status = 'approved', decided_at = now(), decided_by = $1, order_id = $2
       WHERE request_id = $3`,
      [req.user.user_id, orderId, request.request_id]
    );

    await client.query('COMMIT');
    res.json({ success: true, order_id: orderId });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// POST /material-requests/:id/reject
router.post('/:id/reject', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const result = await pool.query(
      `UPDATE material_requests
       SET status = 'rejected', decided_at = now(), decided_by = $1
       WHERE request_id = $2 AND status = 'sent'
       RETURNING request_id`,
      [req.user.user_id, req.params.id]
    );
    if (!result.rows.length) {
      return res.status(409).json({ error: 'Request not found or already decided' });
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /material-requests - public form submission (deliberately no login required)
// Body: { requester_name, requester_email, items: [{ product_id, quantity }, ...],
//         needed_by, warehouse_name, warehouse_email }
router.post('/', async (req, res) => {
  const {
    requester_name,
    requester_email,
    items,
    needed_by,
    warehouse_name,
    warehouse_email,
  } = req.body;

  if (!requester_name || !requester_email || !warehouse_name || !warehouse_email) {
    return res.status(400).json({ error: 'All fields are required' });
  }
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'At least one item is required' });
  }
  for (const item of items) {
    if (!item.product_id || !Number.isInteger(Number(item.quantity)) || Number(item.quantity) < 1) {
      return res.status(400).json({ error: 'Each item needs a valid product and a quantity of at least 1' });
    }
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const productIds = items.map((i) => Number(i.product_id));
    const productsRes = await client.query(
      'SELECT product_id, name FROM products WHERE product_id = ANY($1)',
      [productIds]
    );
    const productMap = new Map(productsRes.rows.map((p) => [p.product_id, p.name]));
    const missing = productIds.filter((id) => !productMap.has(id));
    if (missing.length) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'One of the selected items is no longer available. Please pick another.' });
    }

    const headerRes = await client.query(
      `INSERT INTO material_requests
         (requester_name, requester_email, needed_by, warehouse_name, warehouse_email)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [requester_name, requester_email, needed_by || null, warehouse_name, warehouse_email]
    );
    const request = headerRes.rows[0];

    const savedItems = [];
    for (const item of items) {
      const productId = Number(item.product_id);
      const itemRes = await client.query(
        `INSERT INTO material_request_items (request_id, product_id, item_name, quantity)
         VALUES ($1, $2, $3, $4) RETURNING *`,
        [request.request_id, productId, productMap.get(productId), Number(item.quantity)]
      );
      savedItems.push(itemRes.rows[0]);
    }

    await client.query('COMMIT');

    request.items = savedItems;
    await sendMaterialRequestEmail({ to: warehouse_email, replyTo: requester_email, request });

    res.status(201).json({ success: true, request });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

export default router;