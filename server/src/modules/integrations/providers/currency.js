/**
 * Currency-rate provider adapters. getRates(base) → { base, date, rates: { CODE: rate } } | null.
 * The demo adapter returns null: seeded demo rates are labelled is_demo in the database.
 */
import { config } from '../../../config/env.js';
import { fetchJson, ProviderError } from './http.js';

const demo = {
  name: 'demo', configured: false,
  describe: () => 'Demo mode: exchange rates are seeded demonstration values.',
  getRates: async () => null,
};

function exchangeRateApi({ apiKey, fetchImpl } = {}) {
  const key = apiKey ?? config.currency.exchangeRateApiKey;
  return {
    name: 'exchangerate_api',
    configured: Boolean(key),
    describe: () => (key ? 'ExchangeRate-API daily reference rates.' : 'ExchangeRate-API selected but EXCHANGERATE_API_KEY is empty.'),
    async getRates(base) {
      if (!key) throw new ProviderError('ExchangeRate-API key not configured', { code: 'NOT_CONFIGURED' });
      const body = await fetchJson(`https://v6.exchangerate-api.com/v6/${encodeURIComponent(key)}/latest/${encodeURIComponent(base)}`, {
        provider: 'exchangerate_api', timeoutMs: config.marketData.timeoutMs, fetchImpl,
      });
      if (body?.result !== 'success') throw new ProviderError(`ExchangeRate-API error: ${body?.['error-type'] || 'unknown'}`);
      const date = new Date(body.time_last_update_unix * 1000).toISOString().slice(0, 10);
      return { base, date, rates: body.conversion_rates };
    },
  };
}

export function getCurrencyProvider(overrides = {}) {
  const name = overrides.name || config.currency.provider;
  if (name === 'exchangerate_api') return exchangeRateApi(overrides);
  return demo;
}
