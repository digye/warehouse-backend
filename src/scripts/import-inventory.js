// Bulk-imports products, categories, a warehouse, locations, and stock levels
// from an Excel file with a "Master Inventory" sheet (and optionally a
// "Suppliers" sheet). Safe to re-run: matches existing rows by name/SKU
// instead of creating duplicates, and logs every stock change to
// stock_movements for traceability.
//
// Expected "Master Inventory" columns (header row, any order):
//   Item ID, Item Name, Category, Current Stock, Reorder Level, Unit,
//   Unit Cost (USD), Storage Location, Hazard Class
//
// Expected "Suppliers" columns, if present:
//   Supplier Name, Contact Person, Email, Phone
//
// Usage:
//   node src/scripts/import-inventory.js <path-to-file.xlsx> --warehouse="Warehouse Name"

import XLSX from 'xlsx';
import { pool } from '../db/pool.js';

const filePath = process.argv[2];
const warehouseArg = process.argv.find((a) => a.startsWith('--warehouse='));
const warehouseName = warehouseArg ? warehouseArg.split('=').slice(1).join('=') : null;

if (!filePath || !warehouseName) {
  console.error('Usage: node src/scripts/import-inventory.js <file.xlsx> --warehouse="Warehouse Name"');
  process.exit(1);
}

async function findOrCreate(client, table, idCol, matchCol, matchValue, insertCols = {}) {
  const found = await client.query(
    `SELECT ${idCol} FROM ${table} WHERE lower(${matchCol}) = lower($1) LIMIT 1`,
    [matchValue]
  );
  if (found.rows.length) return found.rows[0][idCol];

  const cols = [matchCol, ...Object.keys(insertCols)];
  const values = [matchValue, ...Object.values(insertCols)];
  const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ');
  const inserted = await client.query(
    `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${placeholders}) RETURNING ${idCol}`,
    values
  );
  return inserted.rows[0][idCol];
}

function cell(row, ...names) {
  for (const n of names) {
    if (row[n] !== undefined && row[n] !== null && row[n] !== '') return row[n];
  }
  return null;
}

async function run() {
  const workbook = XLSX.readFile(filePath);
  const inventorySheet = workbook.Sheets['Master Inventory'];
  if (!inventorySheet) {
    console.error(`No "Master Inventory" sheet found. Sheets in this file: ${workbook.SheetNames.join(', ')}`);
    process.exit(1);
  }
  const rows = XLSX.utils.sheet_to_json(inventorySheet, { defval: null });

  const client = await pool.connect();
  const summary = { productsCreated: 0, productsUpdated: 0, stockSet: 0, errors: [] };

  try {
    const warehouseId = await findOrCreate(
      client, 'warehouses', 'warehouse_id', 'name', warehouseName
    );

    for (const [i, row] of rows.entries()) {
      const sku = cell(row, 'Item ID', 'SKU', 'sku');
      const name = cell(row, 'Item Name', 'Name', 'name');
      const categoryName = cell(row, 'Category', 'category');
      const quantity = Number(cell(row, 'Current Stock', 'Quantity', 'quantity')) || 0;
      const reorderLevel = cell(row, 'Reorder Level');
      const unit = cell(row, 'Unit', 'unit_of_measure');
      const unitCost = cell(row, 'Unit Cost (USD)', 'Unit Cost', 'unit_cost');
      const storageLocation = cell(row, 'Storage Location', 'Location');
      const hazardClass = cell(row, 'Hazard Class');

      if (!sku || !name) {
        summary.errors.push(`Row ${i + 2}: missing Item ID or Item Name, skipped`);
        continue;
      }

      try {
        await client.query('BEGIN');

        const categoryId = categoryName
          ? await findOrCreate(client, 'categories', 'category_id', 'name', categoryName)
          : null;

        const existingProduct = await client.query(
          'SELECT product_id FROM products WHERE lower(sku) = lower($1)',
          [sku]
        );

        let productId;
        if (existingProduct.rows.length) {
          productId = existingProduct.rows[0].product_id;
          await client.query(
            `UPDATE products SET name=$1, category_id=$2, unit_of_measure=$3,
               reorder_level=$4, unit_cost=$5, hazard_class=$6
             WHERE product_id=$7`,
            [name, categoryId, unit, reorderLevel, unitCost, hazardClass, productId]
          );
          summary.productsUpdated++;
        } else {
          const inserted = await client.query(
            `INSERT INTO products (sku, name, category_id, unit_of_measure, reorder_level, unit_cost, hazard_class)
             VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING product_id`,
            [sku, name, categoryId, unit, reorderLevel, unitCost, hazardClass]
          );
          productId = inserted.rows[0].product_id;
          summary.productsCreated++;
        }

        if (storageLocation) {
          const locationId = await findOrCreate(
            client, 'locations', 'location_id', 'aisle', storageLocation,
            { warehouse_id: warehouseId }
          );

          const existingInv = await client.query(
            'SELECT inventory_id, quantity FROM inventory WHERE product_id=$1 AND location_id=$2',
            [productId, locationId]
          );

          if (existingInv.rows.length) {
            const prevQty = existingInv.rows[0].quantity;
            await client.query(
              'UPDATE inventory SET quantity=$1, last_updated=now() WHERE inventory_id=$2',
              [quantity, existingInv.rows[0].inventory_id]
            );
            if (prevQty !== quantity) {
              await client.query(
                `INSERT INTO stock_movements (product_id, from_location_id, to_location_id, quantity, reason)
                 VALUES ($1,$2,$2,$3,'bulk import (adjusted)')`,
                [productId, locationId, quantity - prevQty]
              );
            }
          } else {
            await client.query(
              'INSERT INTO inventory (product_id, location_id, quantity) VALUES ($1,$2,$3)',
              [productId, locationId, quantity]
            );
            await client.query(
              `INSERT INTO stock_movements (product_id, from_location_id, to_location_id, quantity, reason)
               VALUES ($1,$2,$2,$3,'bulk import')`,
              [productId, locationId, quantity]
            );
          }
          summary.stockSet++;
        }

        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        summary.errors.push(`Row ${i + 2} (${sku}): ${err.message}`);
      }
    }

    // Suppliers sheet, if present
    const suppliersSheet = workbook.Sheets['Suppliers'];
    let suppliersImported = 0;
    if (suppliersSheet) {
      const supplierRows = XLSX.utils.sheet_to_json(suppliersSheet, { defval: null });
      for (const row of supplierRows) {
        const supplierName = cell(row, 'Supplier Name', 'Name');
        if (!supplierName) continue;
        const contact = [
          cell(row, 'Contact Person'),
          cell(row, 'Email'),
          cell(row, 'Phone'),
        ].filter(Boolean).join(' | ');
        await findOrCreate(client, 'suppliers', 'supplier_id', 'name', supplierName, {
          contact_info: contact,
        });
        suppliersImported++;
      }
    }

    console.log('\nImport finished.');
    console.log(`  Products created: ${summary.productsCreated}`);
    console.log(`  Products updated: ${summary.productsUpdated}`);
    console.log(`  Stock levels set: ${summary.stockSet}`);
    console.log(`  Suppliers imported: ${suppliersImported}`);
    if (summary.errors.length) {
      console.log(`  Rows skipped due to errors: ${summary.errors.length}`);
      summary.errors.forEach((e) => console.log(`    - ${e}`));
    }
  } finally {
    client.release();
    await pool.end();
  }
}

run().catch((err) => {
  console.error('Import failed:', err.message);
  process.exit(1);
});
