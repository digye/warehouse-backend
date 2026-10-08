// Run with: node src/db/seed-admin.js
// Creates one admin user so you can log in for the first time.
// Edit the values below before running, then delete or rerun as needed.

import bcrypt from 'bcrypt';
import { pool } from './pool.js';

const USERNAME = 'admin';
const PASSWORD = 'warehouse123';
const NAME = 'Admin';

async function run() {
  const hash = await bcrypt.hash(PASSWORD, 10);
  await pool.query(
    `INSERT INTO users (name, username, password_hash, role)
     VALUES ($1, $2, $3, 'admin')
     ON CONFLICT (username) DO UPDATE
       SET password_hash = EXCLUDED.password_hash, name = EXCLUDED.name`,
    [NAME, USERNAME, hash]
  );
  console.log(`Admin user ready. Username: ${USERNAME}  Password: ${PASSWORD}`);
  await pool.end();
}

run();
