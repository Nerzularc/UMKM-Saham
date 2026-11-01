import request from 'supertest';
import { createApp } from '../../src/app.js';
import pool, { query } from '../../src/config/database.js';

export const app = createApp();
export const PASSWORD = 'Demo@1234';
export { query, pool };

function cookieValue(res, name) {
  const all = res.headers['set-cookie'] || [];
  const c = all.find((x) => x.startsWith(`${name}=`));
  return c ? decodeURIComponent(c.split(';')[0].slice(name.length + 1)) : null;
}

/**
 * Logs in and returns a client that sends the session cookie and the CSRF header,
 * like the browser SPA does.
 */
export async function login(email, password = PASSWORD, extra = {}) {
  const res = await request(app).post('/api/v1/auth/login').send({ email, password, ...extra });
  if (res.status !== 200) throw new Error(`Login failed for ${email}: ${res.status} ${JSON.stringify(res.body)}`);
  const token = cookieValue(res, 'token');
  const csrf = cookieValue(res, 'csrf_token');
  const cookie = `token=${token}; csrf_token=${csrf}`;
  const wrap = (method) => (url) => request(app)[method](url).set('Cookie', cookie).set('X-CSRF-Token', csrf);
  return {
    user: res.body.data.user, token, csrf, cookie, response: res,
    get: wrap('get'), post: wrap('post'), put: wrap('put'), patch: wrap('patch'), delete: wrap('delete'),
  };
}

export const anon = () => request(app);

export async function ids() {
  const { rows: orgs } = await query('SELECT id, slug FROM organisations');
  const org = Object.fromEntries(orgs.map((o) => [o.slug, o.id]));
  const { rows: outlets } = await query('SELECT id, code FROM outlets');
  const outlet = Object.fromEntries(outlets.map((o) => [o.code, o.id]));
  const { rows: inst } = await query('SELECT id, symbol FROM instruments');
  const instrument = Object.fromEntries(inst.map((i) => [i.symbol, i.id]));
  const { rows: cats } = await query('SELECT id, code FROM expense_categories WHERE org_id IS NULL');
  const category = Object.fromEntries(cats.map((c) => [c.code, c.id]));
  const { rows: products } = await query('SELECT id, sku FROM products');
  const product = Object.fromEntries(products.map((p) => [p.sku, p.id]));
  return { org1: org['demo-franchise'], org2: org['sumber-rejeki-demo'], outlet, instrument, category, product };
}

export async function closePool() {
  await pool.end();
}
