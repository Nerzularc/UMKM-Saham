import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { login, query, ids, closePool } from '../helpers/api.js';

let c; let id;
beforeAll(async () => {
  c = await login('personal@demo.local');
  id = await ids();
});
afterAll(closePool);

async function newPortfolio(body = {}) {
  const res = await c.post('/api/v1/portfolios').send({ name: `Test ${Date.now()}`, ...body });
  expect(res.status).toBe(201);
  return res.body.data;
}

describe('portfolio transactions and cost basis', () => {
  it('records buys/sells and computes WAC holdings', async () => {
    const p = await newPortfolio();
    const tx = (b) => c.post('/api/v1/transactions').send({ portfolioId: p.id, instrumentId: id.instrument.BBCA, currency: 'IDR', ...b });
    expect((await tx({ transactionType: 'buy', transactionDate: '2025-01-02', quantity: 100, price: 1000, fee: 5000 })).status).toBe(201);
    expect((await tx({ transactionType: 'buy', transactionDate: '2025-01-03', quantity: 100, price: 1200, fee: 0 })).status).toBe(201);
    expect((await tx({ transactionType: 'sell', transactionDate: '2025-01-10', quantity: 50, price: 1500, fee: 1000 })).status).toBe(201);

    const res = await c.get(`/api/v1/portfolios/${p.id}/holdings`);
    const h = res.body.data.holdings.find((x) => x.symbol === 'BBCA');
    // WAC = (100k + 5k + 120k) / 200 = 1125; sold 50 → cost 56,250; proceeds 75,000 − 1,000 = 74,000
    expect(h.openQty).toBe(150);
    expect(h.wac).toBe(1125);
    expect(h.costBasis).toBe(168750);
    expect(h.realisedPnl).toBe(17750);
  });

  it('switching to FIFO recalculates from the ledger', async () => {
    const p = await newPortfolio({ costBasisMethod: 'FIFO' });
    const tx = (b) => c.post('/api/v1/transactions').send({ portfolioId: p.id, instrumentId: id.instrument.TLKM, ...b });
    await tx({ transactionType: 'buy', transactionDate: '2025-02-03', quantity: 100, price: 1000 });
    await tx({ transactionType: 'buy', transactionDate: '2025-02-04', quantity: 100, price: 2000 });
    await tx({ transactionType: 'sell', transactionDate: '2025-02-05', quantity: 100, price: 2500 });
    const h = (await c.get(`/api/v1/portfolios/${p.id}/holdings`)).body.data.holdings[0];
    expect(h.realisedPnl).toBe(150000); // first lot at 1,000
    expect(h.costBasis).toBe(200000);
    await c.put(`/api/v1/portfolios/${p.id}`).send({ costBasisMethod: 'WAC' });
    const w = (await c.get(`/api/v1/portfolios/${p.id}/holdings`)).body.data.holdings[0];
    expect(w.realisedPnl).toBe(100000); // average 1,500
  });

  it('rejects overselling, future dates, unknown instruments and negative values', async () => {
    const p = await newPortfolio();
    const tx = (b) => c.post('/api/v1/transactions').send({ portfolioId: p.id, instrumentId: id.instrument.ASII, ...b });
    await tx({ transactionType: 'buy', transactionDate: '2025-03-03', quantity: 10, price: 100 });
    const oversell = await tx({ transactionType: 'sell', transactionDate: '2025-03-04', quantity: 11, price: 100 });
    expect(oversell.status).toBe(422);
    expect(oversell.body.message).toMatch(/only 10 held/);
    expect((await tx({ transactionType: 'sell', transactionDate: '2025-03-01', quantity: 1, price: 100 })).status).toBe(422); // before the buy
    expect((await tx({ transactionType: 'buy', transactionDate: '2099-01-01', quantity: 1, price: 100 })).status).toBe(422);
    expect((await tx({ transactionType: 'buy', transactionDate: '2025-03-03', quantity: -5, price: 100 })).status).toBe(422);
    expect((await c.post('/api/v1/transactions').send({ portfolioId: p.id, instrumentId: '00000000-0000-4000-8000-000000000000', transactionType: 'buy', transactionDate: '2025-03-03', quantity: 1, price: 1 })).status).toBe(422);
  });

  it('requires an exchange rate when none is stored, and converts when it is', async () => {
    const p = await newPortfolio({ baseCurrency: 'EUR' });
    const res = await c.post('/api/v1/transactions').send({ portfolioId: p.id, instrumentId: id.instrument.AAPL, transactionType: 'buy', transactionDate: '2025-04-01', quantity: 1, price: 100 });
    expect(res.status).toBe(422);
    expect(res.body.message).toMatch(/USD\/EUR/);
    const ok = await c.post('/api/v1/transactions').send({ portfolioId: p.id, instrumentId: id.instrument.AAPL, transactionType: 'buy', transactionDate: '2025-04-01', quantity: 1, price: 100, exchangeRate: 0.9 });
    expect(ok.status).toBe(201);
    expect(Number(ok.body.data.base_amount)).toBe(90);

    const idr = await newPortfolio();
    const auto = await c.post('/api/v1/transactions').send({ portfolioId: idr.id, instrumentId: id.instrument.AAPL, transactionType: 'buy', transactionDate: '2025-04-01', quantity: 1, price: 100 });
    expect(auto.status).toBe(201);
    expect(Number(auto.body.data.exchange_rate)).toBeGreaterThan(10000); // demo USD→IDR rate
  });

  it('audits corrections, requires a reason, and protects later sales', async () => {
    const p = await newPortfolio();
    const tx = (b) => c.post('/api/v1/transactions').send({ portfolioId: p.id, instrumentId: id.instrument.BBRI, ...b });
    const buy = (await tx({ transactionType: 'buy', transactionDate: '2025-05-02', quantity: 100, price: 4000 })).body.data;
    await tx({ transactionType: 'sell', transactionDate: '2025-05-05', quantity: 80, price: 4200 });

    const noReason = await c.put(`/api/v1/transactions/${buy.id}`).send({ transactionType: 'buy', transactionDate: '2025-05-02', instrumentId: id.instrument.BBRI, quantity: 100, price: 4100 });
    expect(noReason.status).toBe(422);
    const fixed = await c.put(`/api/v1/transactions/${buy.id}`).send({ transactionType: 'buy', transactionDate: '2025-05-02', instrumentId: id.instrument.BBRI, quantity: 100, price: 4100, reason: 'Broker note corrected' });
    expect(fixed.status).toBe(200);
    const { rows } = await query("SELECT old_values, new_values, metadata FROM audit_events WHERE action = 'transaction.update' AND resource_id = $1", [buy.id]);
    expect(rows[0].old_values.price).toMatch(/^4000/);
    expect(rows[0].metadata.reason).toBe('Broker note corrected');

    const shrink = await c.put(`/api/v1/transactions/${buy.id}`).send({ transactionType: 'buy', transactionDate: '2025-05-02', instrumentId: id.instrument.BBRI, quantity: 50, price: 4100, reason: 'test' });
    expect(shrink.status).toBe(422);
    expect((await c.delete(`/api/v1/transactions/${buy.id}`)).status).toBe(422);
  });

  it('tracks cash, dividends and returns consistently', async () => {
    const p = await newPortfolio();
    const tx = (b) => c.post('/api/v1/transactions').send({ portfolioId: p.id, ...b });
    await tx({ transactionType: 'deposit', transactionDate: '2025-06-02', totalAmount: 1000000 });
    await tx({ transactionType: 'buy', instrumentId: id.instrument.UNVR, transactionDate: '2025-06-03', quantity: 100, price: 2000, fee: 2000 });
    await tx({ transactionType: 'dividend', instrumentId: id.instrument.UNVR, transactionDate: '2025-06-20', totalAmount: 5000 });
    await tx({ transactionType: 'fee', transactionDate: '2025-06-30', totalAmount: 1000 });
    const s = (await c.get(`/api/v1/portfolios/${p.id}/holdings`)).body.data.summary;
    expect(s.cashTracking).toBe(true);
    expect(s.cashBalance).toBe(1000000 - 202000 + 5000 - 1000);
    expect(s.dividends).toBe(5000);
    // total return = unrealised + realised + dividends − account fees (trading fee is in cost basis)
    expect(s.totalReturn).toBeCloseTo(s.unrealisedPnl + 5000 - 1000, 2);
    const perf = (await c.get(`/api/v1/portfolios/${p.id}/performance`)).body.data;
    expect(perf.mode).toBe('cash');
    expect(perf.series.length).toBeGreaterThan(10);
    expect(perf.twrPct).not.toBeNull();
    expect(perf.pricesAreDemo).toBe(true);
  });

  it('labels simulation portfolios and their transactions', async () => {
    const p = await newPortfolio({ portfolioType: 'simulation' });
    const res = await c.post('/api/v1/transactions').send({ portfolioId: p.id, instrumentId: id.instrument.GOTO, transactionType: 'buy', transactionDate: '2025-07-01', quantity: 100, price: 70 });
    expect(res.body.data.is_simulated).toBe(true);
  });

  it('never executes live broker orders', async () => {
    const res = await c.post('/api/v1/integrations/brokers/orders').send({ symbol: 'BBCA', qty: 1 });
    expect(res.status).toBe(501);
  });

  it('marks demo prices and staleness in instrument data', async () => {
    const res = await c.get('/api/v1/instruments?q=BBCA');
    expect(res.body.data[0].is_demo).toBe(true);
    expect(typeof res.body.data[0].price_stale).toBe('boolean');
  });

  it('manages watchlists', async () => {
    const w = (await c.post('/api/v1/watchlists').send({ name: 'Mine' })).body.data;
    expect((await c.post(`/api/v1/watchlists/${w.id}/items`).send({ instrumentId: id.instrument.NVDA })).status).toBe(201);
    const items = (await c.get(`/api/v1/watchlists/${w.id}/items`)).body.data;
    expect(items.map((i) => i.symbol)).toContain('NVDA');
  });
});
