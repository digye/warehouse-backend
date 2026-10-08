import { Router } from 'express';
import { pool } from '../db/pool.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth);

// GET /inventory - current stock across all locations, joined with product/location names
router.get('/', async (req, res) => {
  const result = await pool.query(`
    SELECT i.inventory_id, p.name AS product, p.sku, l.aisle, l.shelf, l.bin,
           i.quantity, i.last_updated
    FROM inventory i
    JOIN products p ON p.product_id = i.product_id
    JOIN locations l ON l.location_id = i.location_id
    ORDER BY p.name
  `);
  res.json(result.rows);
});

// GET /inventory/location/:locationId - stock at one location
router.get('/location/:locationId', async (req, res) => {
  const result = await pool.query(
    'SELECT * FROM inventory WHERE location_id = $1',
    [req.params.locationId]
  );
  res.json(result.rows);
});

// POST /inventory - add stock for a product at a location (creates the record if new,
// or adds to the existing quantity if that product/location pair already exists)
router.post('/', async (req, res) => {
  const { product_id, location_id, quantity, reason } = req.body;
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const existing = await client.query(
      'SELECT * FROM inventory WHERE product_id = $1 AND location_id = $2 FOR UPDATE',
      [product_id, location_id]
    );

    let row;
    if (existing.rows.length) {
      const updated = await client.query(
        `UPDATE inventory SET quantity = quantity + $1, last_updated = now()
         WHERE inventory_id = $2 RETURNING *`,
        [quantity, existing.rows[0].inventory_id]
      );
      row = updated.rows[0];
    } else {
      const created = await client.query(
        `INSERT INTO inventory (product_id, location_id, quantity)
         VALUES ($1, $2, $3) RETURNING *`,
        [product_id, location_id, quantity]
      );
      row = created.rows[0];
    }

    await client.query(
      `INSERT INTO stock_movements
         (product_id, from_location_id, to_location_id, quantity, user_id, reason)
       VALUES ($1, $2, $2, $3, $4, $5)`,
      [product_id, location_id, quantity, req.user.user_id, reason || 'received']
    );

    await client.query('COMMIT');
    res.status(201).json(row);
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// PATCH /inventory/:id - adjust a quantity, and log the change as a stock movement
router.patch('/:id', async (req, res) => {
  const { quantity, reason } = req.body;
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const current = await client.query(
      'SELECT * FROM inventory WHERE inventory_id = $1 FOR UPDATE',
      [req.params.id]
    );
    if (!current.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Inventory record not found' });
    }

    const row = current.rows[0];
    const updated = await client.query(
      `UPDATE inventory SET quantity = $1, last_updated = now()
       WHERE inventory_id = $2 RETURNING *`,
      [quantity, req.params.id]
    );

    await client.query(
      `INSERT INTO stock_movements
         (product_id, from_location_id, to_location_id, quantity, user_id, reason)
       VALUES ($1, $2, $2, $3, $4, $5)`,
      [row.product_id, row.location_id, quantity - row.quantity, req.user.user_id, reason || 'adjustment']
    );

    await client.query('COMMIT');
    res.json(updated.rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

export default router;
