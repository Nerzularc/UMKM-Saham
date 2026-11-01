import { describe, it, expect, afterAll } from '@jest/globals';
import { login, query, closePool } from '../helpers/api.js';
import { syncMarketPrices } from '../../src/jobs/sync.js';
import { getMarketDataProvider } from '../../src/modules/integrations/providers/marketData.js';
import { fetchJson } from '../../src/modules/integrations/providers/http.js';

afterAll(closePool);

describe('external integrations', () => {
  it('demo provider never fabricates prices and sync is skipped', async () => {
    const provider = getMarketDataProvider({ name: 'demo' });
    expect(await provider.getQuote('BBCA')).toBeNull();
    const result = await syncMarketPrices({ provider });
    expect(result.skipped).toBe(true);
  });

  it('records failed syncs without breaking the application', async () => {
    const failingFetch = async () => ({ ok: false, status: 503, json: async () => ({}) });
    const provider = getMarketDataProvider({ name: 'alpha_vantage', apiKey: 'test-key', fetchImpl: failingFetch });
    // keep the test fast: no retries/backoff
    provider.getQuote = (sym) => fetchJson(`https://example.invalid/q?symbol=${sym}&apikey=test-key`, { provider: 'test', retries: 0, fetchImpl: failingFetch });
    const result = await syncMarketPrices({ provider, trigger: 'test' });
    expect(result.status).toBe('failed');
    const { rows } = await query('SELECT status, error_message, metadata FROM sync_jobs WHERE id = $1', [result.jobId]);
    expect(rows[0].status).toBe('failed');
    expect(JSON.stringify(rows[0])).not.toContain('test-key');
    const c = await login('owner@demo.local');
    expect((await c.get('/api/v1/integrations/status')).status).toBe(200);
  });

  it('updates prices and clears the demo flag when a provider returns data', async () => {
    const okFetch = async () => ({ ok: true, status: 200, json: async () => ({ 'Global Quote': { '05. price': '123.45', '07. latest trading day': '2026-10-27' } }) });
    const provider = getMarketDataProvider({ name: 'alpha_vantage', apiKey: 'k', fetchImpl: okFetch });
    const real = provider.getQuote.bind(provider);
    provider.getQuote = async (s) => (s === 'AAPL' ? real(s) : null);
    const result = await syncMarketPrices({ provider });
    expect(result.synced).toBe(1);
    expect(result.unmapped).toEqual(expect.arrayContaining(['BBCA'])); // IDX not auto-mapped
    const { rows } = await query("SELECT last_price, is_demo, price_source FROM instruments WHERE symbol = 'AAPL'");
    expect(Number(rows[0].last_price)).toBe(123.45);
    expect(rows[0].is_demo).toBe(false);
  });

  it('times out slow providers', async () => {
    const slow = (_url, { signal }) => new Promise((_r, reject) => signal.addEventListener('abort', () => { const e = new Error('aborted'); e.name = 'AbortError'; reject(e); }));
    await expect(fetchJson('https://example.invalid', { provider: 'slow', timeoutMs: 50, retries: 0, fetchImpl: slow })).rejects.toMatchObject({ code: 'TIMEOUT' });
  });
});

describe('database migrations', () => {
  it('applied every migration exactly once and mirrored permissions', async () => {
    const { rows } = await query('SELECT filename FROM schema_migrations ORDER BY filename');
    expect(rows.map((r) => r.filename)).toEqual([
      '001_identity_tenants.sql', '002_stocks.sql', '003_franchise.sql', '004_imports_integrations.sql', '005_security_imports_hardening.sql',
    ]);
    const { rows: rp } = await query("SELECT COUNT(*)::int n FROM role_permissions rp JOIN roles r ON r.id = rp.role_id WHERE r.name = 'staff'");
    expect(rp[0].n).toBeGreaterThan(0);
  });

  it('enforces data-integrity constraints in the database itself', async () => {
    const { rows } = await query('SELECT id FROM outlets LIMIT 1');
    await expect(query("INSERT INTO sales_records (outlet_id, sale_date, gross_sales) VALUES ($1, '2026-01-01', -1)", [rows[0].id])).rejects.toThrow(/chk_sales_non_negative/);
  });
});
