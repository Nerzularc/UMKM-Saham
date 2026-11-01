/**
 * Market-data provider adapters.
 *
 * Interface: { name, configured, live, describe(), getQuote(providerSymbol), mapSymbol(instrument) }
 * getQuote resolves to { price, asOf (ISO), currency? } or null when the provider
 * has no data. Adapters never fabricate prices: the demo adapter returns null.
 *
 * Coverage: Alpha Vantage symbol coverage varies by market and plan. Only US
 * listings (NYSE/NASDAQ) are mapped automatically; any other instrument is
 * synchronised only if an administrator sets instruments.provider_symbol after
 * verifying that the provider supports it.
 */
import { config } from '../../../config/env.js';
import { fetchJson, ProviderError } from './http.js';

const demoProvider = {
  name: 'demo',
  configured: false,
  live: false,
  describe: () => 'Demo mode: prices are seeded demonstration values and are never refreshed from a live source.',
  mapSymbol: () => null,
  getQuote: async () => null,
};

function alphaVantage({ apiKey, fetchImpl } = {}) {
  const key = apiKey ?? config.marketData.alphaVantageKey;
  return {
    name: 'alpha_vantage',
    configured: Boolean(key),
    live: Boolean(key),
    describe: () => (key
      ? 'Alpha Vantage (end-of-day/delayed quotes). Respect your plan limits; free keys allow very few requests per day.'
      : 'Alpha Vantage selected but ALPHA_VANTAGE_API_KEY is empty — no live data.'),
    mapSymbol(instrument) {
      if (instrument.provider_symbol) return instrument.provider_symbol;
      if (['NYSE', 'NASDAQ'].includes(instrument.exchange_code)) return instrument.symbol;
      return null;
    },
    async getQuote(symbol) {
      if (!key) throw new ProviderError('Alpha Vantage API key not configured', { code: 'NOT_CONFIGURED' });
      const url = `https://www.alphavantage.co/query?function=GLOBAL_QUOTE&symbol=${encodeURIComponent(symbol)}&apikey=${encodeURIComponent(key)}`;
      const body = await fetchJson(url, {
        provider: 'alpha_vantage', timeoutMs: config.marketData.timeoutMs, minIntervalMs: config.marketData.minIntervalMs, fetchImpl,
      });
      if (body?.Note || body?.Information) {
        throw new ProviderError('Alpha Vantage rate limit or plan restriction reached', { code: 'RATE_LIMITED' });
      }
      if (body?.['Error Message']) throw new ProviderError('Symbol not supported by Alpha Vantage', { code: 'UNSUPPORTED_SYMBOL' });
      const q = body?.['Global Quote'];
      if (!q || !q['05. price']) return null;
      return { price: q['05. price'], asOf: q['07. latest trading day'], previousClose: q['08. previous close'] || null };
    },
  };
}

export function getMarketDataProvider(overrides = {}) {
  const name = overrides.name || config.marketData.provider;
  if (name === 'alpha_vantage') return alphaVantage(overrides);
  return demoProvider;
}
