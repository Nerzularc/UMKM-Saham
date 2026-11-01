/**
 * Prepares a dedicated test database: reset → migrate → seed.
 * Uses TEST_DATABASE_URL, or DATABASE_URL with "_test" appended to the db name.
 * Refuses to touch a database whose name does not end in "_test".
 */
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import dotenv from 'dotenv';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');

export function testDatabaseUrl() {
  dotenv.config({ path: resolve(root, '.env') });
  if (process.env.TEST_DATABASE_URL) return process.env.TEST_DATABASE_URL;
  const url = new URL(process.env.DATABASE_URL || 'postgresql://umkm_user:umkm_dev_password@localhost:5432/umkm_saham');
  url.pathname = `${url.pathname.replace(/\/$/, '')}_test`;
  return url.toString();
}

export default async function globalSetup() {
  // Unit tests need no database.
  const args = process.argv.join(' ');
  if (/tests[\\/]unit/.test(args) && !/integration|security/.test(args)) return;

  const url = testDatabaseUrl();
  const dbName = new URL(url).pathname.slice(1);
  if (!dbName.endsWith('_test')) throw new Error(`Refusing to reset non-test database "${dbName}".`);
  process.env.TEST_DATABASE_URL = url;

  // Create the test database on first use (requires CREATEDB on the main connection).
  const pg = (await import('pg')).default;
  const admin = new URL(url); admin.pathname = '/postgres';
  const client = new pg.Client({ connectionString: admin.toString() });
  try {
    await client.connect();
    const { rows } = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [dbName]);
    if (!rows.length) await client.query(`CREATE DATABASE "${dbName.replace(/"/g, '')}"`);
  } catch {
    // fall through: the reset step below reports a clear error if the database is unreachable
  } finally {
    await client.end().catch(() => {});
  }

  const env = { ...process.env, NODE_ENV: 'test', TEST_DATABASE_URL: url, DATABASE_URL: url };
  const run = (script) => execFileSync(process.execPath, [resolve(here, '../src/database', script)], { env, stdio: 'pipe' });
  try {
    run('reset.js');
    run('migrate.js');
    run('seed.js');
  } catch (err) {
    const out = `${err.stdout || ''}${err.stderr || ''}`;
    throw new Error(`Test database setup failed (${dbName}). Is PostgreSQL running and does the database exist?\n${out}`);
  }
}
