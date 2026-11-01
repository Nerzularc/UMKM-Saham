import '../config/env.js';
import pg from 'pg';
import { readdir, readFile } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { logger } from '../utils/logger.js';
import { ROLE_PERMISSIONS } from '../services/permissions.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, 'migrations');

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function ensureMigrationsTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id          SERIAL PRIMARY KEY,
      filename    VARCHAR(255) NOT NULL UNIQUE,
      executed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

async function getExecutedMigrations(client) {
  const { rows } = await client.query('SELECT filename FROM schema_migrations ORDER BY filename');
  return new Set(rows.map(r => r.filename));
}

/**
 * The permission matrix lives in code (services/permissions.js) and is mirrored
 * into the permissions/role_permissions tables for reporting and review.
 */
async function syncPermissionTables(client) {
  await client.query('DELETE FROM role_permissions');
  for (const [role, perms] of Object.entries(ROLE_PERMISSIONS)) {
    for (const perm of perms) {
      const [module, ...rest] = perm.split('.');
      const action = rest.pop();
      const resource = rest.join('.') || module;
      const { rows } = await client.query(
        `INSERT INTO permissions (module, resource, action, description) VALUES ($1,$2,$3,$4)
         ON CONFLICT (module, resource, action) DO UPDATE SET description = EXCLUDED.description RETURNING id`,
        [module, resource, action, perm],
      );
      await client.query(
        `INSERT INTO role_permissions (role_id, permission_id) SELECT id, $2 FROM roles WHERE name = $1 ON CONFLICT DO NOTHING`,
        [role, rows[0].id],
      );
    }
  }
}

async function runMigrations() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await ensureMigrationsTable(client);
    const executed = await getExecutedMigrations(client);

    const files = (await readdir(MIGRATIONS_DIR))
      .filter(f => f.endsWith('.sql'))
      .sort();

    let ran = 0;
    for (const file of files) {
      if (executed.has(file)) continue;
      const sql = await readFile(join(MIGRATIONS_DIR, file), 'utf8');
      console.log(`Running migration: ${file}`);
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [file]);
      ran++;
    }

    await syncPermissionTables(client);

    await client.query('COMMIT');
    console.log(`Migrations complete. ${ran} migration(s) applied.`);
  } catch (err) {
    await client.query('ROLLBACK');
    logger.error({ err }, 'Migration failed — rolled back');
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

runMigrations().catch(err => {
  console.error(err);
  process.exit(1);
});
