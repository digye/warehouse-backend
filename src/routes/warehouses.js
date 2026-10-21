import { Router } from 'express';
import { pool } from '../db/pool.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth);

// GET /warehouses
router.get('/', async (req, res) => {
  const result = await pool.query('SELECT * FROM warehouses ORDER BY name');
  res.json(result.rows);
});

// POST /warehouses
router.post('/', async (req, res) => {
  const { name, address, email } = req.body;
  const result = await pool.query(
    'INSERT INTO warehouses (name, address, email) VALUES ($1, $2, $3) RETURNING *',
    [name, address, email]
  );
  res.status(201).json(result.rows[0]);
});

export default router;