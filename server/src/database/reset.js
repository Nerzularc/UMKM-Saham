import '../config/env.js';
import pg from 'pg';
import { logger } from '../utils/logger.js';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function reset() {
  const client = await pool.connect();
  try {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('Database reset is not allowed in production!');
    }
    await client.query('BEGIN');
    await client.query('DROP SCHEMA public CASCADE');
    await client.query('CREATE SCHEMA public');
    await client.query('GRANT ALL ON SCHEMA public TO PUBLIC');
    await client.query('COMMIT');
    console.log('Database reset complete. Run db:migrate to recreate schema.');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

reset().catch(err => { console.error(err); process.exit(1); });
