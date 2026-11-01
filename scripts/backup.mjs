#!/usr/bin/env node
/**
 * Database backup: pg_dump custom format (compressed, restorable with pg_restore).
 *   npm run db:backup                 → backups/umkm_saham-YYYYMMDD-HHMMSS.dump
 *   BACKUP_DIR=... BACKUP_RETENTION=14 (number of newest backups to keep)
 */
import { mkdirSync, writeFileSync, readdirSync, unlinkSync, statSync } from 'fs';
import { resolve } from 'path';
import { loadEnv, connection, pgTool, root } from './db-tools.mjs';

loadEnv();
const c = connection();
const dir = resolve(root, process.env.BACKUP_DIR || 'backups');
mkdirSync(dir, { recursive: true });
const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
const file = resolve(dir, `${c.database}-${stamp}.dump`);

const res = pgTool('pg_dump', ['-d', c.database, '-Fc', '--no-owner', '--no-privileges']);
if (res.status !== 0 || !res.stdout?.length) {
  console.error('Backup failed.');
  process.exit(1);
}
writeFileSync(file, res.stdout);
console.log(`Backup written: ${file} (${(res.stdout.length / 1024).toFixed(1)} KiB)`);

const keep = parseInt(process.env.BACKUP_RETENTION || '14', 10);
const dumps = readdirSync(dir).filter((f) => f.startsWith(`${c.database}-`) && f.endsWith('.dump'))
  .map((f) => ({ f, t: statSync(resolve(dir, f)).mtimeMs })).sort((a, b) => b.t - a.t);
for (const old of dumps.slice(keep)) {
  unlinkSync(resolve(dir, old.f));
  console.log(`Removed old backup (retention ${keep}): ${old.f}`);
}
