import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';

import authRoutes from './routes/auth.js';
import productRoutes from './routes/products.js';
import inventoryRoutes from './routes/inventory.js';
import orderRoutes from './routes/orders.js';
import warehouseRoutes from './routes/warehouses.js';
import locationRoutes from './routes/locations.js';
import materialRequestRoutes from './routes/materialRequests.js';

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

// Public routes
app.use('/api', authRoutes); // POST /api/login
app.use('/api/material-requests', materialRequestRoutes); // POST /api/material-requests

// Protected routes (require a valid login token)
app.use('/api/products', productRoutes);
app.use('/api/inventory', inventoryRoutes);
app.use('/api/orders', orderRoutes);
app.use('/api/warehouses', warehouseRoutes);
app.use('/api/locations', locationRoutes);

app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`Warehouse API running on http://localhost:${PORT}`);
});