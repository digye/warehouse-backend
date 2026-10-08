import { Router } from 'express';
import { pool } from '../db/pool.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth);

// GET /orders - includes each order's line items so the manager can see what's in it
router.get('/', async (req, res) => {
  const orders = await pool.query('SELECT * FROM orders ORDER BY order_date DESC, order_id DESC');
  const items = await pool.query(`
    SELECT oi.order_id, oi.product_id, oi.quantity, p.name AS product_name
    FROM order_items oi
    JOIN products p ON p.product_id = oi.product_id
    WHERE oi.order_id = ANY($1)
  `, [orders.rows.map((o) => o.order_id)]);

  const byOrder = {};
  for (const item of items.rows) {
    (byOrder[item.order_id] ??= []).push(item);
  }

  res.json(orders.rows.map((o) => ({ ...o, items: byOrder[o.order_id] || [] })));
});

// POST /orders - create an order with its line items
router.post('/', async (req, res) => {
  const { customer_or_destination, items } = req.body; // items: [{ product_id, quantity }]
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    const order = await client.query(
      `INSERT INTO orders (customer_or_destination, status) VALUES ($1, 'pending') RETURNING *`,
      [customer_or_destination]
    );
    const orderId = order.rows[0].order_id;

    for (const item of items || []) {
      await client.query(
        `INSERT INTO order_items (order_id, product_id, quantity) VALUES ($1, $2, $3)`,
        [orderId, item.product_id, item.quantity]
      );
    }

    await client.query('COMMIT');
    res.status(201).json(order.rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// PATCH /orders/:id - update status (e.g. packed, shipped)
router.patch('/:id', async (req, res) => {
  const { status } = req.body;
  const result = await pool.query(
    'UPDATE orders SET status = $1 WHERE order_id = $2 RETURNING *',
    [status, req.params.id]
  );
  if (!result.rows.length) return res.status(404).json({ error: 'Order not found' });
  res.json(result.rows[0]);
});

export default router;