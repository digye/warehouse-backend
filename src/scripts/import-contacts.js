// Bulk-imports known requesters and warehouses (with their emails) from a
// spreadsheet, so both populate the material request form's dropdowns.
// Safe to re-run: requesters are matched by email, warehouses by name.
//
// Expected columns (header row, any order, extra spaces are ignored):
//   Name, Email Address, Warehouse Name, Warehouse Email
//
// Usage:
//   node src/scripts/import-contacts.js <path-to-file.xlsx>

import XLSX from 'xlsx';
import { pool } from '../db/pool.js';

const filePath = process.argv[2];
if (!filePath) {
  console.error('Usage: node src/scripts/import-contacts.js <file.xlsx>');
  process.exit(1);
}

function normalizeRow(row) {
  const out = {};
  for (const [k, v] of Object.entries(row)) out[k.trim()] = v;
  return out;
}

function cell(row, ...names) {
  for (const n of names) {
    if (row[n] !== undefined && row[n] !== null && row[n] !== '') return row[n];
  }
  return null;
}

async function run() {
  const workbook = XLSX.readFile(filePath);
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: null }).map(normalizeRow);

  const client = await pool.connect();
  const summary = { requestersAdded: 0, requestersSkipped: 0, warehousesAdded: 0, warehousesUpdated: 0, errors: [] };
  const seenWarehouses = new Set();

  try {
    for (const [i, row] of rows.entries()) {
      const name = cell(row, 'Name', 'Full Name');
      const email = cell(row, 'Email Address', 'Email');
      const warehouseName = cell(row, 'Warehouse Name', 'Warehouse');
      const warehouseEmail = cell(row, 'Warehouse Email');

      if (!name || !email) {
        summary.errors.push(`Row ${i + 2}: missing Name or Email Address, skipped`);
        continue;
      }

      // Matched by name rather than email, so distinct people who happen to
      // share an email address (e.g. a shared department inbox) still each
      // get their own entry in the dropdown.
      const existingRequester = await client.query(
        'SELECT requester_id FROM requesters WHERE lower(name) = lower($1)',
        [name]
      );
      if (existingRequester.rows.length) {
        summary.requestersSkipped++;
      } else {
        await client.query('INSERT INTO requesters (name, email) VALUES ($1, $2)', [name, email]);
        summary.requestersAdded++;
      }

      if (warehouseName && !seenWarehouses.has(warehouseName.toLowerCase())) {
        seenWarehouses.add(warehouseName.toLowerCase());
        const existingWarehouse = await client.query(
          'SELECT warehouse_id, email FROM warehouses WHERE lower(name) = lower($1)',
          [warehouseName]
        );
        if (existingWarehouse.rows.length) {
          if (warehouseEmail && existingWarehouse.rows[0].email !== warehouseEmail) {
            await client.query(
              'UPDATE warehouses SET email = $1 WHERE warehouse_id = $2',
              [warehouseEmail, existingWarehouse.rows[0].warehouse_id]
            );
            summary.warehousesUpdated++;
          }
        } else {
          await client.query(
            'INSERT INTO warehouses (name, email) VALUES ($1, $2)',
            [warehouseName, warehouseEmail]
          );
          summary.warehousesAdded++;
        }
      }
    }

    console.log('\nImport finished.');
    console.log(`  Requesters added: ${summary.requestersAdded}`);
    console.log(`  Requesters already known (same email, skipped): ${summary.requestersSkipped}`);
    console.log(`  Warehouses added: ${summary.warehousesAdded}`);
    console.log(`  Warehouses updated with a new email: ${summary.warehousesUpdated}`);
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