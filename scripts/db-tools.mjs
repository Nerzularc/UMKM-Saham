/** Shared helpers for backup/restore: resolve connection and choose pg_dump/pg_restore. */
import { spawnSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

export const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function loadEnv() {
  const file = resolve(root, '.env');
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  }
}

export function connection() {
  const url = new URL(process.env.DATABASE_URL || 'postgresql://umkm_user:umkm_dev_password@localhost:5432/umkm_saham');
  return {
    url: url.toString(),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    host: url.hostname,
    port: url.port || '5432',
    database: url.pathname.slice(1),
  };
}

const has = (bin) => spawnSync(bin, ['--version'], { stdio: 'ignore', shell: process.platform === 'win32' }).status === 0;

/**
 * Run a PostgreSQL client tool. Prefers a local binary; falls back to the
 * docker-compose container (umkm_saham_db) when the tool is not installed.
 */
export function pgTool(tool, args, { input = null } = {}) {
  const c = connection();
  const container = process.env.DB_CONTAINER || 'umkm_saham_db';
  if (has(tool)) {
    return spawnSync(tool, ['-h', c.host, '-p', c.port, '-U', c.user, ...args], {
      env: { ...process.env, PGPASSWORD: c.password }, stdio: ['pipe', 'pipe', 'inherit'], input, maxBuffer: 1024 * 1024 * 1024,
    });
  }
  if (!has('docker')) throw new Error(`${tool} not found and Docker is unavailable. Install PostgreSQL client tools.`);
  return spawnSync('docker', ['exec', '-i', '-e', `PGPASSWORD=${c.password}`, container, tool, '-U', c.user, ...args], {
    stdio: ['pipe', 'pipe', 'inherit'], input, maxBuffer: 1024 * 1024 * 1024,
  });
}
