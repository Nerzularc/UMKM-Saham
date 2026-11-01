import cron from 'node-cron';
import { config } from '../config/env.js';
import { logger } from '../utils/logger.js';
import { syncMarketPrices, syncCurrencyRates } from './sync.js';
import { query } from '../config/database.js';

/** Background jobs. Disabled in tests and when ENABLE_JOBS=false. */
export function startJobs() {
  if (config.marketData.provider !== 'demo') {
    if (!cron.validate(config.marketData.refreshCron)) {
      logger.error(`Invalid MARKET_DATA_REFRESH_CRON "${config.marketData.refreshCron}" — price sync not scheduled.`);
    } else {
      cron.schedule(config.marketData.refreshCron, () => syncMarketPrices().catch((e) => logger.error(e)), { timezone: config.timezone });
      logger.info(`Market-data sync scheduled (${config.marketData.refreshCron}, ${config.marketData.provider}).`);
    }
  }
  if (config.currency.provider !== 'demo') {
    cron.schedule('15 6 * * *', () => syncCurrencyRates().catch((e) => logger.error(e)), { timezone: config.timezone });
  }
  // Housekeeping: drop expired sessions daily.
  cron.schedule('0 3 * * *', () => query("DELETE FROM sessions WHERE expires_at < NOW() - INTERVAL '7 days'").catch(() => {}), { timezone: config.timezone });
}
