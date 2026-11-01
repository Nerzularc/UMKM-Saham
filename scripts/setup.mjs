#!/usr/bin/env node
/**
 * First-time local setup (cross-platform):
 *   1. creates .env from .env.example if missing
 *   2. replaces placeholder secrets with strong random values
 * Then run: npm run db:migrate && npm run db:seed
 */
import { existsSync, readFileSync, writeFileSync, copyFileSync } from 'fs';
import { randomBytes } from 'crypto';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const envPath = resolve(root, '.env');
const examplePath = resolve(root, '.env.example');

if (!existsSync(envPath)) {
  copyFileSync(examplePath, envPath);
  console.log('Created .env from .env.example');
}

let env = readFileSync(envPath, 'utf8');
let changed = 0;
for (const key of ['JWT_SECRET', 'TOTP_ENCRYPTION_KEY']) {
  const re = new RegExp(`^${key}=(.*)$`, 'm');
  const m = env.match(re);
  const value = randomBytes(48).toString('hex');
  if (!m) { env += `\n${key}=${value}\n`; changed++; }
  else if (!m[1] || /^CHANGE_THIS/.test(m[1])) { env = env.replace(re, `${key}=${value}`); changed++; }
}
writeFileSync(envPath, env);
console.log(changed ? `Generated ${changed} secret(s) in .env` : '.env secrets already set');
console.log('\nNext steps:\n  docker compose up -d        (or start your own PostgreSQL)\n  npm run db:migrate\n  npm run db:seed\n  npm run dev');
