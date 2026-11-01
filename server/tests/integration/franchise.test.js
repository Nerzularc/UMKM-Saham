import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { login, query, ids, closePool } from '../helpers/api.js';

let owner; let manager; let staff; let id;

/** A full calendar month n months before the current one (inside the seeded range). */
function monthAgo(n) {
  const d = new Date();
  const first = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - n, 1));
  const last = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0));
  return { from: first.toISOString().slice(0, 10), to: last.toISOString().slice(0, 10), year: first.getUTCFullYear(), month: first.getUTCMonth() + 1, days: last.getUTCDate() };
}
const M2 = monthAgo(2);
const M4 = monthAgo(4);
beforeAll(async () => {
  [owner, manager, staff] = await Promise.all([login('owner@demo.local'), login('manager@demo.local'), login('staff@demo.local')]);
  id = await ids();
});
afterAll(closePool);

describe('franchise reporting consistency', () => {
  const period = `from=${monthAgo(5).from}&to=${M2.to}`;

  it('dashboard, outlet comparison and P&L report agree for the same period', async () => {
    const dash = (await owner.get(`/api/v1/franchise/dashboard?orgId=${id.org1}&${period}`)).body.data;
    const cmp = (await owner.get(`/api/v1/franchise/comparison?orgId=${id.org1}&${period}`)).body.data;
    const pnl = (await owner.get(`/api/v1/reports/franchise/pnl?orgId=${id.org1}&${period}`)).body;
    const sumOutlets = cmp.outlets.reduce((s, o) => s + o.netSales, 0);
    const sumMonths = pnl.data.reduce((s, m) => s + m.netSales, 0);
    expect(Math.round(sumOutlets)).toBe(Math.round(dash.summary.netSales));
    expect(Math.round(sumMonths)).toBe(Math.round(dash.summary.netSales));
    expect(Math.round(pnl.meta.total.netProfit)).toBe(Math.round(dash.summary.netProfit));

    const { rows } = await query(
      `SELECT SUM(sr.net_sales) AS n FROM sales_records sr JOIN outlets o ON o.id = sr.outlet_id
        WHERE o.org_id = $1 AND sr.deleted_at IS NULL AND sr.sale_date BETWEEN $2 AND $3`, [id.org1, monthAgo(5).from, M2.to],
    );
    expect(Math.round(dash.summary.netSales)).toBe(Math.round(Number(rows[0].n)));
  });

  it('computes P&L lines with the documented formulas', async () => {
    const m = (await owner.get(`/api/v1/reports/franchise/pnl?orgId=${id.org1}&${period}`)).body.data[0];
    expect(m.netSales).toBeCloseTo(m.grossSales - m.discounts - m.returns, 2);
    expect(m.grossProfit).toBeCloseTo(m.netSales - m.cogs, 2);
    expect(m.operatingProfit).toBeCloseTo(m.grossProfit - m.operatingExpenses, 2);
    expect(m.grossMarginPct).toBeCloseTo((m.grossProfit / m.netSales) * 100, 1);
  });

  it('scopes managers to assigned outlets and hides profit from staff', async () => {
    const mgr = (await manager.get(`/api/v1/franchise/dashboard?orgId=${id.org1}&${period}`)).body.data;
    expect(mgr.outlets.map((o) => o.code).sort()).toEqual(['MAB-BKS', 'MAB-DPK', 'WKN-JAKPUS', 'WKN-JAKSEL']);
    const st = (await staff.get(`/api/v1/franchise/dashboard?orgId=${id.org1}&${period}`)).body.data;
    expect(st.outlets.map((o) => o.code)).toEqual(['WKN-JAKSEL']);
    expect(st.canSeeFinancials).toBe(false);
    expect(st.summary.netProfit).toBeUndefined();
    expect(st.outlets[0].netProfit).toBeUndefined();
    expect((await staff.get(`/api/v1/reports/franchise/pnl?orgId=${id.org1}`)).status).toBe(403);
  });
});

describe('sales and expenses', () => {
  it('creates sales with validation and audit', async () => {
    const bad = await staff.post('/api/v1/sales').send({ outletId: id.outlet['WKN-JAKSEL'], saleDate: '2026-02-01', grossSales: 100, discounts: 80, returns: 30 });
    expect(bad.status).toBe(422);
    const neg = await staff.post('/api/v1/sales').send({ outletId: id.outlet['WKN-JAKSEL'], saleDate: '2026-02-01', grossSales: -5 });
    expect(neg.status).toBe(422);
    const ok = await staff.post('/api/v1/sales').send({ outletId: id.outlet['WKN-JAKSEL'], saleDate: '2026-02-01', grossSales: 250000, discounts: 10000, transactionCount: 7 });
    expect(ok.status).toBe(201);
    expect(Number(ok.body.data.net_sales)).toBe(240000);
    const { rows } = await query("SELECT 1 FROM audit_events WHERE action = 'sales.create' AND resource_id = $1", [ok.body.data.id]);
    expect(rows.length).toBe(1);
  });

  it('lists sales with totals and pagination', async () => {
    const res = await owner.get(`/api/v1/sales?orgId=${id.org1}&from=${M2.from}&to=${M2.to}&limit=10&sort=net&order=desc`);
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBe(10);
    expect(res.body.meta.total).toBe(M2.days * 5);
    expect(Number(res.body.data[0].net_sales)).toBeGreaterThanOrEqual(Number(res.body.data[1].net_sales));
  });

  it('records expenses only in allowed categories', async () => {
    const ok = await manager.post('/api/v1/expenses').send({ outletId: id.outlet['MAB-DPK'], expenseCategoryId: id.category.MAINT, expenseDate: '2026-03-15', amount: 750000 });
    expect(ok.status).toBe(201);
    const badCat = await manager.post('/api/v1/expenses').send({ outletId: id.outlet['MAB-DPK'], expenseCategoryId: '00000000-0000-4000-8000-000000000000', expenseDate: '2026-03-15', amount: 1 });
    expect(badCat.status).toBe(404);
  });
});

describe('targets', () => {
  it('upserts targets and computes achievement over the target period', async () => {
    const t = await owner.post('/api/v1/targets').send({ orgId: id.org1, outletId: id.outlet['WKN-BDG'], periodType: 'monthly', periodYear: M4.year, periodValue: M4.month, targetAmount: 30000000 });
    expect([200, 201]).toContain(t.status);
    const list = (await owner.get(`/api/v1/targets?orgId=${id.org1}&outletId=${id.outlet['WKN-BDG']}&year=${M4.year}&month=${M4.month}`)).body.data;
    expect(list).toHaveLength(1);
    const { rows } = await query(`SELECT SUM(net_sales) n FROM sales_records WHERE outlet_id = $1 AND sale_date BETWEEN $2 AND $3 AND deleted_at IS NULL`, [id.outlet['WKN-BDG'], M4.from, M4.to]);
    expect(list[0].actual).toBeCloseTo(Number(rows[0].n), 2);
    expect(list[0].achievement_pct).toBeCloseTo((Number(rows[0].n) / 30000000) * 100, 1);
    // managers may only target their own outlets
    const mgr = await manager.post('/api/v1/targets').send({ orgId: id.org1, outletId: id.outlet['WKN-BDG'], periodType: 'monthly', periodYear: M4.year, periodValue: M4.month, targetAmount: 1 });
    expect(mgr.status).toBe(403);
  });
});

describe('inventory', () => {
  it('moves stock, blocks negative balances and keeps movement history', async () => {
    const outlet = id.outlet['WKN-JAKPUS'];
    const product = id.product['PKG-001'];
    const before = (await manager.get(`/api/v1/inventory?outletId=${outlet}`)).body.data.find((r) => r.product_id === product);
    const rec = await manager.post('/api/v1/inventory/movements').send({ outletId: outlet, productId: product, movementType: 'receive', quantity: 100, unitCost: 900 });
    expect(rec.status).toBe(201);
    expect(Number(rec.body.data.balance)).toBe(Number(before.quantity) + 100);
    const tooMuch = await manager.post('/api/v1/inventory/movements').send({ outletId: outlet, productId: product, movementType: 'issue', quantity: 1e7 });
    expect(tooMuch.status).toBe(422);
    const adjNoNote = await manager.post('/api/v1/inventory/movements').send({ outletId: outlet, productId: product, movementType: 'adjustment', quantity: -1 });
    expect(adjNoNote.status).toBe(422);
    const hist = (await manager.get(`/api/v1/inventory/movements?outletId=${outlet}&productId=${product}`)).body.data;
    expect(hist[0].movement_type).toBe('receive');
  });

  it('transfers stock between authorised outlets atomically', async () => {
    const from = id.outlet['WKN-JAKSEL']; const to = id.outlet['WKN-JAKPUS']; const product = id.product['KPI-002'];
    const res = await manager.post('/api/v1/inventory/transfers').send({ fromOutletId: from, toOutletId: to, productId: product, quantity: 5 });
    expect(res.status).toBe(201);
    const { rows } = await query('SELECT outlet_id, quantity FROM inventory_movements WHERE transfer_id = $1', [res.body.data.transferId]);
    expect(rows).toHaveLength(2);
    expect(rows.reduce((s, r) => s + Number(r.quantity), 0)).toBe(0);
    // Manager is not assigned to Bandung
    const denied = await manager.post('/api/v1/inventory/transfers').send({ fromOutletId: from, toOutletId: id.outlet['WKN-BDG'], productId: product, quantity: 1 });
    expect(denied.status).toBe(403);
    // Staff lacks the transfer permission
    const staffT = await staff.post('/api/v1/inventory/transfers').send({ fromOutletId: from, toOutletId: to, productId: product, quantity: 1 });
    expect(staffT.status).toBe(403);
  });
});

describe('approval workflow', () => {
  it('routes configured changes through approval with separation of duties', async () => {
    const enable = await owner.patch(`/api/v1/organisations/${id.org1}`).send({ approvals: { enabled: true, separationOfDuties: true, actions: ['sales.update', 'sales.delete'] } });
    expect(enable.status).toBe(200);
    try {
      const sale = (await staff.post('/api/v1/sales').send({ outletId: id.outlet['WKN-JAKSEL'], saleDate: '2026-02-02', grossSales: 100000 })).body.data;
      const noReason = await staff.put(`/api/v1/sales/${sale.id}`).send({ grossSales: 120000 });
      expect(noReason.status).toBe(422);
      const req = await staff.put(`/api/v1/sales/${sale.id}`).send({ grossSales: 120000, reason: 'Missed a receipt' });
      expect(req.status).toBe(202);
      const approvalId = req.body.data.approval.id;
      const { rows: unchanged } = await query('SELECT gross_sales FROM sales_records WHERE id = $1', [sale.id]);
      expect(Number(unchanged[0].gross_sales)).toBe(100000);

      expect((await staff.post(`/api/v1/approvals/${approvalId}/approve`)).status).toBe(403); // no review permission

      // Owner requests a change → owner cannot approve own request
      const own = await owner.delete(`/api/v1/sales/${sale.id}`).send({ reason: 'Duplicate entry' });
      expect(own.status).toBe(202);
      expect((await owner.post(`/api/v1/approvals/${own.body.data.approval.id}/approve`)).status).toBe(403);

      const approve = await manager.post(`/api/v1/approvals/${approvalId}/approve`).send({ notes: 'Checked' });
      expect(approve.status).toBe(200);
      const { rows: changed } = await query('SELECT gross_sales FROM sales_records WHERE id = $1', [sale.id]);
      expect(Number(changed[0].gross_sales)).toBe(120000);
      expect((await manager.post(`/api/v1/approvals/${approvalId}/approve`)).status).toBe(409);
    } finally {
      await owner.patch(`/api/v1/organisations/${id.org1}`).send({ approvals: { enabled: false } });
    }
  });
});
