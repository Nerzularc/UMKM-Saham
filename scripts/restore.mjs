#!/usr/bin/env node
/**
 * Restore a backup made by scripts/backup.mjs.
 *   npm run db:restore -- backups/umkm_saham-20261028-101500.dump
 *   npm run db:restore -- <file> --yes          (skip confirmation)
 *   RESTORE_DATABASE_URL=postgresql://.../scratch npm run db:restore -- <file> --yes
 *     (restore into another database, e.g. to verify a backup)
 *
 * Existing objects are dropped and recreated (pg_restore --clean --if-exists).
 */
import { readFileSync, existsSync } from 'fs';
import { createInterface } from 'readline/promises';
import { loadEnv, connection, pgTool } from './db-tools.mjs';

loadEnv();
const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--'));
if (!file || !existsSync(file)) {
  console.error('Usage: npm run db:restore -- <backup.dump> [--yes]');
  process.exit(1);
}
if (process.env.RESTORE_DATABASE_URL) process.env.DATABASE_URL = process.env.RESTORE_DATABASE_URL;
if (process.env.NODE_ENV === 'production' && !args.includes('--force')) {
  console.error('Refusing to restore in production without --force.');
  process.exit(1);
}
const c = connection();
if (!args.includes('--yes')) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(`This replaces all data in "${c.database}" on ${c.host}. Type the database name to continue: `);
  rl.close();
  if (answer.trim() !== c.database) { console.log('Cancelled.'); process.exit(1); }
}
const res = pgTool('pg_restore', ['-d', c.database, '--clean', '--if-exists', '--no-owner', '--no-privileges', '--single-transaction'], { input: readFileSync(file) });
if (res.status !== 0) {
  console.error('Restore failed.');
  process.exit(1);
}
console.log(`Restored ${file} into ${c.database}.`);
