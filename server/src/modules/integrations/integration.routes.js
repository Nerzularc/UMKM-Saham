import express from 'express';
import { requireAuth, requireSuperadmin } from '../../middleware/auth.js';
import { query } from '../../config/database.js';
import { successResponse } from '../../utils/response.js';
import { config } from '../../config/env.js';
import { getMarketDataProvider } from './providers/marketData.js';
import { getCurrencyProvider } from './providers/currency.js';
import { brokerStatus } from './providers/brokers.js';
import { syncMarketPrices, syncCurrencyRates } from '../../jobs/sync.js';
import { audit } from '../audit/audit.service.js';

const router = express.Router();
router.use(requireAuth);

async function lastJob(type) {
  const { rows } = await query(
    `SELECT id, status, started_at, completed_at, records_synced, error_message
       FROM sync_jobs WHERE job_type = $1 ORDER BY created_at DESC LIMIT 1`, [type],
  );
  return rows[0] || null;
}

// GET /api/v1/integrations/status — provider configuration (no secrets) and last sync
router.get('/status', async (_req, res, next) => {
  try {
    const md = getMarketDataProvider();
    const fx = getCurrencyProvider();
    const { rows: [prices] } = await query(
      `SELECT COUNT(*) FILTER (WHERE is_demo)::int AS demo_instruments,
              COUNT(*) FILTER (WHERE NOT is_demo AND last_price IS NOT NULL)::int AS live_instruments,
              MAX(last_price_at) FILTER (WHERE NOT is_demo) AS last_live_price_at
         FROM instruments WHERE is_active`,
    );
    return successResponse(res, {
      demoMode: config.demoMode,
      marketData: {
        provider: md.name, configured: md.configured, live: md.live, description: md.describe(),
        refreshSchedule: md.live ? config.marketData.refreshCron : null,
        lastSync: await lastJob('market_prices'), ...prices,
      },
      currency: { provider: fx.name, configured: fx.configured, description: fx.describe(), lastSync: await lastJob('currency_rates') },
      brokers: brokerStatus(),
      pos: { adapters: [{ name: 'csv_import', label: 'POS export (CSV/XLSX import)', configured: true }], liveAdapters: [] },
    });
  } catch (err) { next(err); }
});

router.post('/market-data/sync', requireSuperadmin, async (req, res, next) => {
  try {
    const result = await syncMarketPrices({ trigger: 'manual' });
    await audit(req, { action: 'integration.market_sync', resourceType: 'integration', resourceId: 'market_data', metadata: { status: result.status || 'skipped' } });
    return successResponse(res, result);
  } catch (err) { next(err); }
});

router.post('/currency/sync', requireSuperadmin, async (req, res, next) => {
  try {
    const result = await syncCurrencyRates({ trigger: 'manual' });
    await audit(req, { action: 'integration.currency_sync', resourceType: 'integration', resourceId: 'currency', metadata: { status: result.status || 'skipped' } });
    return successResponse(res, result);
  } catch (err) { next(err); }
});

// Order execution is deliberately unavailable: no approved broker API is configured.
router.post('/brokers/orders', (_req, res) => res.status(501).json({
  success: false,
  message: config.demoMode
    ? 'Live order execution is never available in demo mode.'
    : 'No broker with order-execution support is configured. Use a simulation portfolio for paper trading.',
}));

export default router;
