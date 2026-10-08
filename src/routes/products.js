import { Router } from 'express';
import { pool } from '../db/pool.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth);

// GET /products
router.get('/', async (req, res) => {
  const result = await pool.query('SELECT * FROM products ORDER BY name');
  res.json(result.rows);
});

// GET /products/:id
router.get('/:id', async (req, res) => {
  const result = await pool.query(
    'SELECT * FROM products WHERE product_id = $1',
    [req.params.id]
  );
  if (!result.rows.length) return res.status(404).json({ error: 'Product not found' });
  res.json(result.rows[0]);
});

// POST /products
router.post('/', async (req, res) => {
  const { sku, name, description, unit_of_measure, category_id } = req.body;
  const result = await pool.query(
    `INSERT INTO products (sku, name, description, unit_of_measure, category_id)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [sku, name, description, unit_of_measure, category_id]
  );
  res.status(201).json(result.rows[0]);
});

// PATCH /products/:id
router.patch('/:id', async (req, res) => {
  const { sku, name, description, unit_of_measure, category_id } = req.body;
  const result = await pool.query(
    `UPDATE products SET
       sku = COALESCE($1, sku),
       name = COALESCE($2, name),
       description = COALESCE($3, description),
       unit_of_measure = COALESCE($4, unit_of_measure),
       category_id = COALESCE($5, category_id)
     WHERE product_id = $6 RETURNING *`,
    [sku, name, description, unit_of_measure, category_id, req.params.id]
  );
  if (!result.rows.length) return res.status(404).json({ error: 'Product not found' });
  res.json(result.rows[0]);
});

// DELETE /products/:id
router.delete('/:id', async (req, res) => {
  await pool.query('DELETE FROM products WHERE product_id = $1', [req.params.id]);
  res.status(204).end();
});

export default router;
