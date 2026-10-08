// Run with: npm run db:init
// Creates all tables from the project's data model. Safe to re-run (uses IF NOT EXISTS).

import { pool } from './pool.js';

const schema = `
CREATE TABLE IF NOT EXISTS categories (
  category_id SERIAL PRIMARY KEY,
  name TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS products (
  product_id SERIAL PRIMARY KEY,
  sku TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  unit_of_measure TEXT,
  category_id INTEGER REFERENCES categories(category_id)
);

CREATE TABLE IF NOT EXISTS warehouses (
  warehouse_id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  address TEXT
);

CREATE TABLE IF NOT EXISTS locations (
  location_id SERIAL PRIMARY KEY,
  warehouse_id INTEGER REFERENCES warehouses(warehouse_id),
  aisle TEXT,
  shelf TEXT,
  bin TEXT
);

CREATE TABLE IF NOT EXISTS inventory (
  inventory_id SERIAL PRIMARY KEY,
  product_id INTEGER REFERENCES products(product_id),
  location_id INTEGER REFERENCES locations(location_id),
  quantity INTEGER NOT NULL DEFAULT 0,
  last_updated TIMESTAMP DEFAULT now()
);

CREATE TABLE IF NOT EXISTS suppliers (
  supplier_id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  contact_info TEXT
);

CREATE TABLE IF NOT EXISTS purchase_orders (
  po_id SERIAL PRIMARY KEY,
  supplier_id INTEGER REFERENCES suppliers(supplier_id),
  status TEXT DEFAULT 'pending',
  order_date DATE DEFAULT CURRENT_DATE,
  expected_date DATE
);

CREATE TABLE IF NOT EXISTS purchase_order_items (
  po_item_id SERIAL PRIMARY KEY,
  po_id INTEGER REFERENCES purchase_orders(po_id),
  product_id INTEGER REFERENCES products(product_id),
  quantity_ordered INTEGER NOT NULL,
  quantity_received INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS orders (
  order_id SERIAL PRIMARY KEY,
  customer_or_destination TEXT NOT NULL,
  status TEXT DEFAULT 'pending',
  order_date DATE DEFAULT CURRENT_DATE
);

CREATE TABLE IF NOT EXISTS order_items (
  order_item_id SERIAL PRIMARY KEY,
  order_id INTEGER REFERENCES orders(order_id),
  product_id INTEGER REFERENCES products(product_id),
  quantity INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  user_id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'staff'
);

CREATE TABLE IF NOT EXISTS stock_movements (
  movement_id SERIAL PRIMARY KEY,
  product_id INTEGER REFERENCES products(product_id),
  from_location_id INTEGER REFERENCES locations(location_id),
  to_location_id INTEGER REFERENCES locations(location_id),
  quantity INTEGER NOT NULL,
  user_id INTEGER REFERENCES users(user_id),
  reason TEXT,
  created_at TIMESTAMP DEFAULT now()
);

CREATE TABLE IF NOT EXISTS material_requests (
  request_id SERIAL PRIMARY KEY,
  requester_name TEXT NOT NULL,
  requester_email TEXT NOT NULL,
  item_name TEXT NOT NULL,
  quantity INTEGER NOT NULL,
  needed_by TIMESTAMP,
  warehouse_name TEXT NOT NULL,
  warehouse_email TEXT NOT NULL,
  status TEXT DEFAULT 'sent',
  created_at TIMESTAMP DEFAULT now()
);

-- Approval tracking (safe to re-run on an existing table)
ALTER TABLE material_requests ADD COLUMN IF NOT EXISTS decided_at TIMESTAMP;
ALTER TABLE material_requests ADD COLUMN IF NOT EXISTS decided_by INTEGER REFERENCES users(user_id);
ALTER TABLE material_requests ADD COLUMN IF NOT EXISTS product_id INTEGER REFERENCES products(product_id);

-- A request can now hold multiple line items, so the old single item_name/quantity
-- columns on material_requests are no longer required per row.
ALTER TABLE material_requests ALTER COLUMN item_name DROP NOT NULL;
ALTER TABLE material_requests ALTER COLUMN quantity DROP NOT NULL;

CREATE TABLE IF NOT EXISTS material_request_items (
  request_item_id SERIAL PRIMARY KEY,
  request_id INTEGER REFERENCES material_requests(request_id) ON DELETE CASCADE,
  product_id INTEGER REFERENCES products(product_id),
  item_name TEXT NOT NULL,
  quantity INTEGER NOT NULL
);

-- Links an approved request to the order record it automatically created
ALTER TABLE material_requests ADD COLUMN IF NOT EXISTS order_id INTEGER REFERENCES orders(order_id);

-- One-time migration: carry any existing single-item requests into the new
-- items table, so older test data still shows up correctly. Safe to re-run —
-- it skips requests that already have items.
INSERT INTO material_request_items (request_id, product_id, item_name, quantity)
SELECT request_id, product_id, item_name, quantity
FROM material_requests r
WHERE item_name IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM material_request_items i WHERE i.request_id = r.request_id
  );
`;

async function run() {
  try {
    await pool.query(schema);
    console.log('Database schema created successfully.');
  } catch (err) {
    console.error('Failed to create schema:', err.message);
  } finally {
    await pool.end();
  }
}

run();