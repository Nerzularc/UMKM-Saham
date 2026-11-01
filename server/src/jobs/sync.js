/**
 * Synchronisation jobs. Each run is recorded in sync_jobs with status,
 * counts and a non-secret error summary, so failures are visible to admins.
 */
import { query } from '../config/database.js';
import { logger } from '../utils/logger.js';
import { getMarketDataProvider } from '../modules/integrations/providers/marketData.js';
import { getCurrencyProvider } from '../modules/integrations/providers/currency.js';
import { randomUUID as uuidv4 } from 'crypto';

let running = new Set();

async function startJob(jobType, metadata) {
  const id = uuidv4();
  await query(
    `INSERT INTO sync_jobs (id, job_type, status, started_at, metadata) VALUES ($1,$2,'running',NOW(),$3)`,
    [id, jobType, JSON.stringify(metadata || {})],
  );
  return id;
}

async function finishJob(id, status, { records = 0, error = null, metadata = null } = {}) {
  await query(
    `UPDATE sync_jobs SET status = $2, completed_at = NOW(), records_synced = $3, error_message = $4,
       metadata = COALESCE(metadata, '{}'::jsonb) || COALESCE($5::jsonb, '{}'::jsonb)
     WHERE id = $1`,
    [id, status, records, error, metadata ? JSON.stringify(metadata) : null],
  );
}

export async function syncMarketPrices({ provider = getMarketDataProvider(), trigger = 'schedule' } = {}) {
  if (!provider.live) {
    return { skipped: true, reason: provider.describe() };
  }
  if (running.has('market')) return { skipped: true, reason: 'A market-data sync is already running.' };
  running.add('market');
  const jobId = await startJob('market_prices', { provider: provider.name, trigger });
  let synced = 0;
  const failures = [];
  const unmapped = [];
  try {
    const { rows: instruments } = await query(
      `SELECT i.id, i.symbol, i.provider_symbol, e.code AS exchange_code
         FROM instruments i JOIN exchanges e ON e.id = i.exchange_id
        WHERE i.is_active = TRUE AND e.code <> 'DEMO' ORDER BY i.last_price_at NULLS FIRST LIMIT 200`,
    );
    for (const inst of instruments) {
      const symbol = provider.mapSymbol(inst);
      if (!symbol) { unmapped.push(inst.symbol); continue; }
      try {
        const quote = await provider.getQuote(symbol);
        if (!quote) { failures.push({ symbol: inst.symbol, code: 'NO_DATA' }); continue; }
        await query(
          `UPDATE instruments SET last_price = $2, last_price_at = $3::date + TIME '23:59', price_source = $4, is_demo = FALSE
            WHERE id = $1`,
          [inst.id, quote.price, quote.asOf, provider.name],
        );
        await query(
          `INSERT INTO price_observations (instrument_id, price_date, close_price, is_demo, source)
           VALUES ($1,$2,$3,FALSE,$4)
           ON CONFLICT (instrument_id, price_date) DO UPDATE SET close_price = EXCLUDED.close_price, is_demo = FALSE, source = EXCLUDED.source`,
          [inst.id, quote.asOf, quote.price, provider.name],
        );
        synced++;
      } catch (err) {
        failures.push({ symbol: inst.symbol, code: err.code || 'ERROR' });
        if (err.code === 'RATE_LIMITED' || err.code === 'NOT_CONFIGURED') break; // stop early, retry next schedule
      }
    }
    const status = failures.length && !synced ? 'failed' : failures.length ? 'partial' : 'done';
    await finishJob(jobId, status, {
      records: synced,
      error: failures.length ? `${failures.length} instrument(s) failed` : null,
      metadata: { failures: failures.slice(0, 50), unmapped: unmapped.slice(0, 100) },
    });
    return { jobId, status, synced, failures, unmapped };
  } catch (err) {
    logger.error({ err: err.message }, 'Market price sync failed');
    await finishJob(jobId, 'failed', { records: synced, error: err.message });
    return { jobId, status: 'failed', error: err.message };
  } finally {
    running.delete('market');
  }
}

export async function syncCurrencyRates({ provider = getCurrencyProvider(), base = 'USD', targets = ['IDR', 'SGD', 'EUR', 'GBP', 'JPY', 'HKD'], trigger = 'schedule' } = {}) {
  if (!provider.configured) return { skipped: true, reason: provider.describe() };
  const jobId = await startJob('currency_rates', { provider: provider.name, trigger });
  try {
    const data = await provider.getRates(base);
    let count = 0;
    for (const code of targets) {
      const rate = data?.rates?.[code];
      if (!rate) continue;
      await query(
        `INSERT INTO exchange_rates (from_currency, to_currency, rate, rate_date, source, is_demo)
         VALUES ($1,$2,$3,$4,$5,FALSE)
         ON CONFLICT (from_currency, to_currency, rate_date) DO UPDATE SET rate = EXCLUDED.rate, source = EXCLUDED.source, is_demo = FALSE`,
        [base, code, rate, data.date, provider.name],
      );
      count++;
    }
    await finishJob(jobId, 'done', { records: count });
    return { jobId, status: 'done', synced: count };
  } catch (err) {
    await finishJob(jobId, 'failed', { error: err.message });
    return { jobId, status: 'failed', error: err.message };
  }
}

export function _resetSyncState() { running = new Set(); }
