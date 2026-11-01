/**
 * Environment loader.
 *
 * The project keeps a single `.env` at the repository root. Node is usually
 * started from `server/` (npm workspaces), so `dotenv/config` alone would look
 * in the wrong folder. This module resolves the root file explicitly and must
 * be imported before anything that reads `process.env`.
 */
import dotenv from 'dotenv';
import { existsSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '../../..');

for (const candidate of [resolve(ROOT, '.env'), resolve(ROOT, 'server/.env')]) {
  if (existsSync(candidate)) dotenv.config({ path: candidate });
}

// Tests run against a separate database when TEST_DATABASE_URL is configured.
if (process.env.NODE_ENV === 'test' && process.env.TEST_DATABASE_URL) {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
}

const PLACEHOLDER = /^CHANGE_THIS/;
const isProd = process.env.NODE_ENV === 'production';

if (!process.env.JWT_SECRET || PLACEHOLDER.test(process.env.JWT_SECRET)) {
  if (isProd) {
    throw new Error('JWT_SECRET must be set to a long random value in production.');
  }
  // Development/test fallback: random per process, so sessions do not survive restarts
  // and nothing predictable is ever used to sign tokens.
  const { randomBytes } = await import('crypto');
  process.env.JWT_SECRET = randomBytes(48).toString('hex');
  if (process.env.NODE_ENV !== 'test') {
    console.warn('[env] JWT_SECRET not set — using a random development secret. Sessions reset on restart.');
  }
}

export const config = {
  root: ROOT,
  env: process.env.NODE_ENV || 'development',
  isProd,
  isTest: process.env.NODE_ENV === 'test',
  port: parseInt(process.env.PORT || '3000', 10),
  clientOrigin: process.env.CLIENT_ORIGIN || 'http://localhost:5173',
  demoMode: process.env.DEMO_MODE !== 'false',
  timezone: process.env.DEFAULT_TIMEZONE || 'Asia/Jakarta',
  maxUploadBytes: parseInt(process.env.MAX_UPLOAD_SIZE_MB || '10', 10) * 1024 * 1024,
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '7d',
  marketData: {
    provider: (process.env.MARKET_DATA_PROVIDER || 'demo').toLowerCase(),
    alphaVantageKey: process.env.ALPHA_VANTAGE_API_KEY || '',
    refreshCron: process.env.MARKET_DATA_REFRESH_CRON || '*/30 * * * 1-5',
    timeoutMs: parseInt(process.env.PROVIDER_TIMEOUT_MS || '10000', 10),
    minIntervalMs: parseInt(process.env.PROVIDER_MIN_INTERVAL_MS || '15000', 10),
  },
  currency: {
    provider: (process.env.CURRENCY_PROVIDER || 'demo').toLowerCase(),
    exchangeRateApiKey: process.env.EXCHANGERATE_API_KEY || '',
  },
  jobsEnabled: process.env.ENABLE_JOBS !== 'false' && process.env.NODE_ENV !== 'test',
};
