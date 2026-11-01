import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { anon, login, query, ids, closePool } from '../helpers/api.js';

let owner; let owner2; let manager; let staff; let personal; let superadmin; let id;
let org1Sale; let org1Expense; let personalPortfolio;

beforeAll(async () => {
  [owner, owner2, manager, staff, personal, superadmin] = await Promise.all(
    ['owner', 'owner2', 'manager', 'staff', 'personal', 'superadmin'].map((u) => login(`${u}@demo.local`)),
  );
  id = await ids();
  org1Sale = (await query('SELECT id FROM sales_records WHERE outlet_id = $1 AND deleted_at IS NULL LIMIT 1', [id.outlet['WKN-BDG']])).rows[0].id;
  org1Expense = (await query('SELECT id FROM operating_expenses WHERE outlet_id = $1 LIMIT 1', [id.outlet['WKN-BDG']])).rows[0].id;
  personalPortfolio = (await query("SELECT p.id FROM portfolios p JOIN users u ON u.id = p.user_id WHERE u.email = 'personal@demo.local' LIMIT 1")).rows[0].id;
});
afterAll(closePool);

describe('unauthenticated access', () => {
  const protectedRoutes = [
    '/api/v1/auth/me', '/api/v1/portfolios', '/api/v1/transactions', '/api/v1/watchlists', '/api/v1/instruments',
    '/api/v1/organisations', '/api/v1/franchise/dashboard', '/api/v1/outlets', '/api/v1/sales', '/api/v1/expenses',
    '/api/v1/inventory', '/api/v1/targets', '/api/v1/imports', '/api/v1/exports/sales', '/api/v1/reports/franchise/pnl',
    '/api/v1/audit', '/api/v1/approvals', '/api/v1/admin/stats', '/api/v1/integrations/status',
  ];
  it.each(protectedRoutes)('GET %s → 401', async (route) => {
    expect((await anon().get(route)).status).toBe(401);
  });

  it('rejects forged and tampered tokens', async () => {
    const forged = await anon().get('/api/v1/auth/me').set('Authorization', 'Bearer eyJhbGciOiJub25lIn0.eyJzdWIiOiJ4In0.');
    expect(forged.status).toBe(401);
    const tampered = `${owner.token.slice(0, -2)}xx`;
    expect((await anon().get('/api/v1/auth/me').set('Authorization', `Bearer ${tampered}`)).status).toBe(401);
  });
});

describe('cross-tenant isolation (owner of org 2 → org 1 data)', () => {
  it('cannot read the other organisation’s dashboards and reports', async () => {
    expect((await owner2.get(`/api/v1/franchise/dashboard?orgId=${id.org1}`)).status).toBe(403);
    expect((await owner2.get(`/api/v1/reports/franchise/pnl?orgId=${id.org1}`)).status).toBe(403);
    expect((await owner2.get(`/api/v1/outlets?orgId=${id.org1}`)).status).toBe(403);
    expect((await owner2.get(`/api/v1/brands?orgId=${id.org1}`)).status).toBe(403);
    expect((await owner2.get(`/api/v1/organisations/${id.org1}`)).status).toBe(403);
    expect((await owner2.get(`/api/v1/organisations/${id.org1}/members`)).status).toBe(403);
  });

  it('cannot reach resources by guessing identifiers (IDOR)', async () => {
    expect((await owner2.get(`/api/v1/outlets/${id.outlet['WKN-BDG']}`)).status).toBe(404);
    expect((await owner2.get(`/api/v1/sales?outletId=${id.outlet['WKN-BDG']}`)).status).toBe(404);
    expect((await owner2.get(`/api/v1/inventory?outletId=${id.outlet['WKN-BDG']}`)).status).toBe(404);
    expect((await owner2.put(`/api/v1/sales/${org1Sale}`).send({ grossSales: 1 })).status).toBe(404);
    expect((await owner2.delete(`/api/v1/sales/${org1Sale}`)).status).toBe(404);
    expect((await owner2.delete(`/api/v1/expenses/${org1Expense}`)).status).toBe(404);
    const { rows } = await query('SELECT deleted_at, gross_sales FROM sales_records WHERE id = $1', [org1Sale]);
    expect(rows[0].deleted_at).toBeNull();
  });

  it('cannot write into the other organisation by putting its ids in the body', async () => {
    expect((await owner2.post('/api/v1/sales').send({ outletId: id.outlet['WKN-BDG'], saleDate: '2026-01-01', grossSales: 1 })).status).toBe(404);
    expect((await owner2.post('/api/v1/outlets').send({ orgId: id.org1, brandId: (await query('SELECT id FROM brands WHERE org_id = $1 LIMIT 1', [id.org1])).rows[0].id, name: 'x' })).status).toBe(403);
    // own org, but a brand id belonging to org 1
    const foreignBrand = (await query('SELECT id FROM brands WHERE org_id = $1 LIMIT 1', [id.org1])).rows[0].id;
    expect((await owner2.post('/api/v1/outlets').send({ orgId: id.org2, brandId: foreignBrand, name: 'x' })).status).toBe(404);
    expect((await owner2.post('/api/v1/targets').send({ orgId: id.org2, outletId: id.outlet['WKN-BDG'], periodType: 'monthly', periodYear: 2026, periodValue: 1, targetAmount: 1 })).status).toBe(404);
    // own-org filter with a foreign outlet id must not leak data
    expect((await owner2.get(`/api/v1/franchise/dashboard?orgId=${id.org2}&outletId=${id.outlet['WKN-BDG']}`)).status).toBe(404);
  });

  it('cannot export or import for the other organisation', async () => {
    expect((await owner2.get(`/api/v1/exports/sales?orgId=${id.org1}`)).status).toBe(403);
    expect((await owner2.get(`/api/v1/exports/franchise-pnl?orgId=${id.org1}`)).status).toBe(403);
    expect((await owner2.get(`/api/v1/exports/audit?orgId=${id.org1}`)).status).toBe(403);
    const up = await owner2.post('/api/v1/imports').field('entityType', 'sales').field('orgId', id.org1).attach('file', Buffer.from('a\n1\n'), 'x.csv');
    expect(up.status).toBe(403);
  });

  it('cannot see the other organisation’s audit trail or approvals', async () => {
    expect((await owner2.get(`/api/v1/audit?orgId=${id.org1}`)).status).toBe(403);
    expect((await owner2.get(`/api/v1/approvals?orgId=${id.org1}`)).status).toBe(403);
  });
});

describe('role and scope enforcement inside one organisation', () => {
  it('managers and staff cannot reach outlets they are not assigned to', async () => {
    expect((await manager.get(`/api/v1/outlets/${id.outlet['WKN-BDG']}`)).status).toBe(403);
    expect((await staff.get(`/api/v1/sales?outletId=${id.outlet['WKN-JAKPUS']}`)).status).toBe(403);
    expect((await staff.post('/api/v1/sales').send({ outletId: id.outlet['WKN-JAKPUS'], saleDate: '2026-01-01', grossSales: 1 })).status).toBe(403);
    const list = (await manager.get(`/api/v1/sales?orgId=${id.org1}&limit=500`)).body.data;
    expect(list.some((s) => s.outlet_code === 'WKN-BDG')).toBe(false);
  });

  it('staff cannot export, manage structure, members or approvals', async () => {
    expect((await staff.get(`/api/v1/exports/sales?orgId=${id.org1}`)).status).toBe(403);
    expect((await staff.post('/api/v1/brands').send({ orgId: id.org1, name: 'Hack' })).status).toBe(403);
    expect((await staff.get(`/api/v1/organisations/${id.org1}/members`)).status).toBe(403);
    expect((await staff.patch(`/api/v1/organisations/${id.org1}`).send({ name: 'Hacked' })).status).toBe(403);
  });

  it('prevents privilege escalation', async () => {
    // staff tries to promote themselves
    expect((await staff.post(`/api/v1/organisations/${id.org1}/members`).send({ email: 'staff@demo.local', role: 'manager' })).status).toBe(403);
    // manager cannot add members
    expect((await manager.post(`/api/v1/organisations/${id.org1}/members`).send({ email: 'personal@demo.local', role: 'staff' })).status).toBe(403);
    // owner cannot hand out org_owner or superadmin through the API
    expect((await owner.post(`/api/v1/organisations/${id.org1}/members`).send({ email: 'personal@demo.local', role: 'org_owner' })).status).toBe(422);
    expect((await owner.post(`/api/v1/organisations/${id.org1}/members`).send({ email: 'personal@demo.local', role: 'superadmin' })).status).toBe(422);
    // owner cannot demote themselves (lock-out protection)
    expect((await owner.patch(`/api/v1/organisations/${id.org1}/members/${owner.user.id}`).send({ role: 'staff' })).status).toBe(403);
    // non-superadmins cannot use admin endpoints
    expect((await owner.get('/api/v1/admin/users')).status).toBe(403);
    expect((await owner.patch(`/api/v1/admin/users/${staff.user.id}`).send({ isActive: false })).status).toBe(403);
    // mass assignment of is_superadmin through profile update is ignored
    await staff.patch('/api/v1/users/me').send({ isSuperadmin: true, is_superadmin: true });
    const { rows } = await query("SELECT is_superadmin FROM users WHERE email = 'staff@demo.local'");
    expect(rows[0].is_superadmin).toBe(false);
  });

  it('logs permission changes', async () => {
    const res = await owner.post(`/api/v1/organisations/${id.org1}/members`).send({ email: 'owner2@demo.local', role: 'staff' });
    expect(res.status).toBe(201);
    await owner.patch(`/api/v1/organisations/${id.org1}/members/${owner2.user.id}`).send({ isActive: false });
    const { rows } = await query("SELECT action FROM audit_events WHERE org_id = $1 AND action LIKE 'member.%' ORDER BY created_at", [id.org1]);
    expect(rows.map((r) => r.action)).toEqual(expect.arrayContaining(['member.added', 'member.deactivated']));
  });
});

describe('personal portfolios', () => {
  it('are invisible to other users', async () => {
    expect((await owner.get(`/api/v1/portfolios/${personalPortfolio}`)).status).toBe(404);
    expect((await owner.get(`/api/v1/portfolios/${personalPortfolio}/holdings`)).status).toBe(404);
    expect((await owner.get(`/api/v1/transactions?portfolioId=${personalPortfolio}`)).status).toBe(404);
    expect((await owner.get(`/api/v1/exports/stock-holdings?portfolioId=${personalPortfolio}`)).status).toBe(404);
    expect((await owner.post('/api/v1/transactions').send({ portfolioId: personalPortfolio, transactionType: 'deposit', transactionDate: '2025-01-01', totalAmount: 1 })).status).toBe(404);
    const w = (await query("SELECT w.id FROM watchlists w JOIN users u ON u.id = w.user_id WHERE u.email = 'personal@demo.local' LIMIT 1")).rows[0].id;
    expect((await owner.post(`/api/v1/watchlists/${w}/items`).send({ instrumentId: id.instrument.BBCA })).status).toBe(404);
  });

  it('organisation portfolios are readable by managers but not editable', async () => {
    const orgP = (await query('SELECT id FROM portfolios WHERE org_id = $1 LIMIT 1', [id.org1])).rows[0].id;
    expect((await manager.get(`/api/v1/portfolios/${orgP}/holdings`)).status).toBe(200);
    expect((await manager.delete(`/api/v1/portfolios/${orgP}`)).status).toBe(403);
    expect((await staff.get(`/api/v1/portfolios/${orgP}`)).status).toBe(403);
  });
});

describe('superadmin boundaries', () => {
  it('manages the platform but does not see tenant financials', async () => {
    expect((await superadmin.get('/api/v1/admin/stats')).status).toBe(200);
    expect((await superadmin.get(`/api/v1/franchise/dashboard?orgId=${id.org1}`)).status).toBe(403);
    const audit = (await superadmin.get(`/api/v1/admin/audit?orgId=${id.org1}`)).body.data;
    expect(audit.length).toBeGreaterThan(0);
    expect(audit.every((a) => a.old_values === null && a.new_values === null)).toBe(true);
  });
});

describe('input handling and error hygiene', () => {
  it('returns 400 (not 500) for malformed identifiers and never leaks stack traces', async () => {
    const res = await owner.get(`/api/v1/outlets/not-a-uuid`);
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).not.toMatch(/stack|at .*\.js|SELECT|postgres/i);
    const r2 = await owner.get(`/api/v1/franchise/dashboard?orgId=${id.org1}&from=2026-13-45`);
    expect(r2.status).toBe(400);
  });

  it('treats SQL injection attempts as data', async () => {
    const res = await owner.get(`/api/v1/outlets?orgId=${id.org1}&q=${encodeURIComponent("' OR 1=1; DROP TABLE users; --")}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(0);
    const sort = await owner.get(`/api/v1/sales?orgId=${id.org1}&sort=${encodeURIComponent('1; DROP TABLE sales_records')}`);
    expect(sort.status).toBe(200);
    expect((await query('SELECT COUNT(*) FROM users')).rows[0].count).not.toBe('0');
  });

  it('rejects malformed JSON safely', async () => {
    const res = await anon().post('/api/v1/auth/login').set('Content-Type', 'application/json').send('{"email":');
    expect(res.status).toBe(400);
  });

  it('keeps the audit trail append-only', async () => {
    await expect(query("UPDATE audit_events SET action = 'tampered'")).rejects.toThrow(/append-only/);
    await expect(query('DELETE FROM audit_events')).rejects.toThrow(/append-only/);
  });

  it('does not expose secrets in responses', async () => {
    const me = await owner.get('/api/v1/users/me');
    expect(JSON.stringify(me.body)).not.toMatch(/password_hash|two_factor_secret|token_hash/);
    const status = await owner.get('/api/v1/integrations/status');
    expect(JSON.stringify(status.body)).not.toMatch(/apikey|api_key/i);
  });

  it('sends security headers', async () => {
    const res = await anon().get('/api/v1/health');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-security-policy']).toMatch(/default-src 'self'/);
    expect(res.headers['x-powered-by']).toBeUndefined();
  });
});
