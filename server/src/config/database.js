import './env.js';
import pg from 'pg';
import { logger } from '../utils/logger.js';

const { Pool } = pg;

// DATE columns are calendar dates, not instants: keep them as 'YYYY-MM-DD'
// strings so no timezone conversion can shift a business day.
pg.types.setTypeParser(1082, (value) => value);

const connection = process.env.DATABASE_URL
  ? { connectionString: process.env.DATABASE_URL }
  : {
      host: process.env.DB_HOST || 'localhost',
      port: parseInt(process.env.DB_PORT || '5432', 10),
      user: process.env.DB_USER || 'umkm_user',
      password: process.env.DB_PASSWORD || 'umkm_dev_password',
      database: process.env.DB_NAME || 'umkm_saham',
    };

// NUMERIC columns are returned as strings by node-postgres on purpose:
// financial values must never be silently converted to binary floats.
const pool = new Pool({
  ...connection,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
  ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
});

pool.on('error', (err) => {
  logger.error({ err }, 'Unexpected database pool error');
});

/**
 * Execute a parameterised query. Always use this — never string-concatenate SQL.
 * @param {string} text  SQL with $1, $2 … placeholders
 * @param {any[]}  params
 */
export async function query(text, params) {
  const start = Date.now();
  const result = await pool.query(text, params);
  const ms = Date.now() - start;
  if (ms > 500) {
    logger.warn({ query: text, ms }, 'Slow query detected');
  }
  return result;
}

/**
 * Get a client from the pool for transactions.
 */
export async function getClient() {
  return pool.connect();
}

/**
 * Run callback inside a database transaction.
 * Rolls back and rethrows on error.
 */
export async function withTransaction(callback) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export default pool;
