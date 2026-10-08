import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const { Pool } = pg;

// Locally, there's no DATABASE_URL, so pg reads PGHOST / PGPORT / PGDATABASE /
// PGUSER / PGPASSWORD from .env automatically.
//
// On Render (and most hosts), the database is given as one DATABASE_URL instead,
// and the connection needs SSL. ssl: { rejectUnauthorized: false } is what
// Render's own docs recommend, since their internal certificates aren't
// publicly signed.
export const pool = process.env.DATABASE_URL
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false },
    })
  : new Pool();

export async function query(text, params) {
  return pool.query(text, params);
}