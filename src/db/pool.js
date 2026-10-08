import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const { Pool } = pg;

// Reads PGHOST / PGPORT / PGDATABASE / PGUSER / PGPASSWORD from your .env automatically
export const pool = new Pool();

export async function query(text, params) {
  return pool.query(text, params);
}
