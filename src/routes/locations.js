import { Router } from 'express';
import { pool } from '../db/pool.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth);

// GET /locations - includes the warehouse name for display
router.get('/', async (req, res) => {
  const result = await pool.query(`
    SELECT l.*, w.name AS warehouse_name
    FROM locations l
    JOIN warehouses w ON w.warehouse_id = l.warehouse_id
    ORDER BY w.name, l.aisle, l.shelf, l.bin
  `);
  res.json(result.rows);
});

// POST /locations
router.post('/', async (req, res) => {
  const { warehouse_id, aisle, shelf, bin } = req.body;
  const result = await pool.query(
    `INSERT INTO locations (warehouse_id, aisle, shelf, bin)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [warehouse_id, aisle, shelf, bin]
  );
  res.status(201).json(result.rows[0]);
});

export default router;
