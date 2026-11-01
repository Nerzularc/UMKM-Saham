/**
 * Demonstration seed data.
 *
 * EVERYTHING created here is demonstration data: prices are generated with a
 * deterministic random walk, sales/expenses are synthetic, and every instrument,
 * price observation, exchange rate and portfolio transaction is flagged
 * is_demo = TRUE (franchise rows use source = 'demo_seed').
 *
 * Demo accounts use the development-only password printed at the end. Never run
 * this against a production database.
 */
import '../config/env.js';
import pg from 'pg';
import bcrypt from 'bcryptjs';
import { randomUUID as uuidv4 } from 'crypto';

pg.types.setTypeParser(1082, (v) => v);
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const DEMO_PASSWORD = process.env.DEMO_PASSWORD || 'Demo@1234';

// Deterministic PRNG so every seed produces identical demo data.
function mulberry32(a) {
  return function rand() {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(20261028);

const iso = (d) => d.toISOString().slice(0, 10);
function todayJakarta() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jakarta' }).format(new Date());
}
function addDays(isoDate, n) {
  const d = new Date(`${isoDate}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return iso(d);
}
function businessDays(from, to) {
  const out = [];
  for (let d = from; d <= to; d = addDays(d, 1)) {
    const wd = new Date(`${d}T00:00:00Z`).getUTCDay();
    if (wd !== 0 && wd !== 6) out.push(d);
  }
  return out;
}

async function seed() {
  if (process.env.NODE_ENV === 'production' && process.env.ALLOW_DEMO_SEED !== 'true') {
    throw new Error('Refusing to seed demonstration data in production.');
  }
  const client = await pool.connect();
  try {
    const { rows: already } = await client.query("SELECT 1 FROM users WHERE email = 'owner@demo.local'");
    if (already.length) {
      console.log('Demo data already present — nothing to do.');
      console.log('To recreate it: npm run db:reset && npm run db:migrate && npm run db:seed');
      return;
    }

    await client.query('BEGIN');
    console.log('Seeding DEMONSTRATION data (not real prices or financial records)…');
    const today = todayJakarta();
    const hash = await bcrypt.hash(DEMO_PASSWORD, 10);

    // ── Users ──────────────────────────────────────────────────────────────
    const U = {
      superadmin: uuidv4(), owner: uuidv4(), manager: uuidv4(), staff: uuidv4(), personal: uuidv4(), owner2: uuidv4(),
    };
    const users = [
      [U.superadmin, 'superadmin@demo.local', 'Super Admin (Demo)', 'id', true],
      [U.owner, 'owner@demo.local', 'Budi Santoso (Demo)', 'id', false],
      [U.manager, 'manager@demo.local', 'Siti Rahayu (Demo)', 'id', false],
      [U.staff, 'staff@demo.local', 'Ahmad Fauzi (Demo)', 'id', false],
      [U.personal, 'personal@demo.local', 'Jane Doe (Demo)', 'en', false],
      [U.owner2, 'owner2@demo.local', 'Dewi Lestari (Demo)', 'id', false],
    ];
    for (const [id, email, name, locale, sa] of users) {
      await client.query(
        `INSERT INTO users (id, email, password_hash, full_name, locale, is_superadmin, email_verified)
         VALUES ($1,$2,$3,$4,$5,$6,TRUE)`, [id, email, hash, name, locale, sa],
      );
    }

    const { rows: roleRows } = await client.query('SELECT id, name FROM roles');
    const role = Object.fromEntries(roleRows.map((r) => [r.name, r.id]));

    // ── Organisations ──────────────────────────────────────────────────────
    const org1 = uuidv4();
    const org2 = uuidv4();
    await client.query(
      `INSERT INTO organisations (id, name, slug, description, default_currency, owner_id, modules_enabled) VALUES
        ($1,'PT Demo Franchise','demo-franchise','Demo organisation — synthetic data','IDR',$2,'["stocks","franchise"]'),
        ($3,'CV Sumber Rejeki (Demo)','sumber-rejeki-demo','Second demo tenant for isolation testing','IDR',$4,'["franchise"]')`,
      [org1, U.owner, org2, U.owner2],
    );
    const member = (org, user, r) => client.query(
      'INSERT INTO org_memberships (id, org_id, user_id, role_id, is_active, joined_at) VALUES ($1,$2,$3,$4,TRUE,NOW())',
      [uuidv4(), org, user, role[r]],
    );
    await member(org1, U.owner, 'org_owner');
    await member(org1, U.manager, 'manager');
    await member(org1, U.staff, 'staff');
    await member(org2, U.owner2, 'org_owner');

    // ── Instruments and price history ─────────────────────────────────────
    const { rows: exRows } = await client.query('SELECT id, code FROM exchanges');
    const ex = Object.fromEntries(exRows.map((r) => [r.code, r.id]));
    const instruments = [
      { sym: 'BBCA', name: 'Bank Central Asia Tbk', exch: 'IDX', cur: 'IDR', price: 9750, sector: 'Financials', vol: 0.014 },
      { sym: 'TLKM', name: 'Telkom Indonesia Tbk', exch: 'IDX', cur: 'IDR', price: 3410, sector: 'Communication Services', vol: 0.016 },
      { sym: 'ASII', name: 'Astra International Tbk', exch: 'IDX', cur: 'IDR', price: 4780, sector: 'Consumer Discretionary', vol: 0.017 },
      { sym: 'BBRI', name: 'Bank Rakyat Indonesia Tbk', exch: 'IDX', cur: 'IDR', price: 5150, sector: 'Financials', vol: 0.016 },
      { sym: 'GOTO', name: 'GoTo Gojek Tokopedia Tbk', exch: 'IDX', cur: 'IDR', price: 75, sector: 'Technology', vol: 0.03 },
      { sym: 'UNVR', name: 'Unilever Indonesia Tbk', exch: 'IDX', cur: 'IDR', price: 2650, sector: 'Consumer Staples', vol: 0.015 },
      { sym: 'AAPL', name: 'Apple Inc.', exch: 'NASDAQ', cur: 'USD', price: 189.3, sector: 'Technology', vol: 0.015 },
      { sym: 'MSFT', name: 'Microsoft Corporation', exch: 'NASDAQ', cur: 'USD', price: 415.2, sector: 'Technology', vol: 0.014 },
      { sym: 'GOOGL', name: 'Alphabet Inc.', exch: 'NASDAQ', cur: 'USD', price: 175.5, sector: 'Communication Services', vol: 0.017 },
      { sym: 'NVDA', name: 'NVIDIA Corporation', exch: 'NASDAQ', cur: 'USD', price: 120.0, sector: 'Technology', vol: 0.028 },
    ];
    const historyStart = '2024-01-02';
    const days = businessDays(historyStart, today);
    const inst = {};
    for (const i of instruments) {
      const id = uuidv4();
      inst[i.sym] = { id, ...i };
      // Random walk backwards from the seed price so the latest close equals it.
      const closes = new Array(days.length);
      let p = i.price;
      for (let k = days.length - 1; k >= 0; k--) {
        closes[k] = i.cur === 'IDR' ? Math.max(1, Math.round(p)) : Math.round(p * 100) / 100;
        p /= Math.exp((rand() - 0.5) * 2 * i.vol + 0.0002);
      }
      await client.query(
        `INSERT INTO instruments (id, exchange_id, symbol, name, currency, sector, last_price, last_price_at, price_source, is_demo)
         VALUES ($1,$2,$3,$4,$5,$6,$7,NOW() - INTERVAL '2 hours','demo_seed',TRUE)`,
        [id, ex[i.exch], i.sym, i.name, i.cur, i.sector, closes[closes.length - 1]],
      );
      const opens = closes.map((c, k) => (k ? closes[k - 1] : c));
      await client.query(
        `INSERT INTO price_observations (instrument_id, price_date, open_price, high_price, low_price, close_price, volume, is_demo, source)
         SELECT $1, d::date, o, GREATEST(o, c) * 1.004, LEAST(o, c) * 0.996, c, v, TRUE, 'demo_seed'
           FROM unnest($2::text[], $3::numeric[], $4::numeric[], $5::bigint[]) AS t(d, o, c, v)`,
        [id, days, opens, closes, closes.map(() => Math.floor(rand() * 40_000_000) + 1_000_000)],
      );
      inst[i.sym].closeOn = (date) => {
        let lo = 0, hi = days.length - 1, ans = closes[0];
        while (lo <= hi) { const m = (lo + hi) >> 1; if (days[m] <= date) { ans = closes[m]; lo = m + 1; } else hi = m - 1; }
        return ans;
      };
    }

    // Exchange rates (demo): USD→IDR and SGD→IDR random walks, daily.
    const fxDays = []; for (let d = '2024-01-01'; d <= today; d = addDays(d, 1)) fxDays.push(d);
    const fxSeries = {};
    for (const [from, end, vol] of [['USD', 16250, 0.003], ['SGD', 12100, 0.003]]) {
      const vals = new Array(fxDays.length);
      let r = end;
      for (let k = fxDays.length - 1; k >= 0; k--) { vals[k] = Math.round(r * 100) / 100; r /= Math.exp((rand() - 0.5) * 2 * vol); }
      fxSeries[from] = vals;
      await client.query(
        `INSERT INTO exchange_rates (from_currency, to_currency, rate, rate_date, source, is_demo)
         SELECT $1, 'IDR', v, d::date, 'demo_seed', TRUE FROM unnest($2::text[], $3::numeric[]) AS t(d, v)`,
        [from, fxDays, vals],
      );
    }
    const usdIdr = (date) => fxSeries.USD[Math.max(0, fxDays.indexOf(date))];

    // ── Portfolios ─────────────────────────────────────────────────────────
    const addTx = async (portfolioId, t, base = 'IDR') => {
      const i = t.sym ? inst[t.sym] : null;
      const currency = t.currency || i?.cur || base;
      const fx = currency === base ? 1 : (base === 'IDR' && currency === 'USD' ? usdIdr(t.date) : 1);
      const total = ['buy', 'sell'].includes(t.type) ? t.qty * t.price : t.total;
      await client.query(
        `INSERT INTO portfolio_transactions (id, portfolio_id, instrument_id, transaction_type, transaction_date,
           quantity, price, total_amount, fee, currency, exchange_rate, base_amount, notes, is_demo, is_simulated)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,TRUE,$14)`,
        [uuidv4(), portfolioId, i?.id || null, t.type, t.date, t.qty ?? null, t.price ?? null,
          total.toFixed(2), (t.fee || 0).toFixed(2), currency, fx, (total * fx).toFixed(2), t.notes || null, !!t.simulated],
      );
    };
    const px = (sym, date) => inst[sym].closeOn(date);

    const pIdx = uuidv4();
    await client.query(
      `INSERT INTO portfolios (id, user_id, name, description, base_currency, cost_basis_method, is_default)
       VALUES ($1,$2,'Demo Portfolio IDX','Demonstration portfolio — not real investments','IDR','WAC',TRUE)`, [pIdx, U.personal],
    );
    const idxTrades = [
      { sym: 'BBCA', type: 'buy', date: '2024-01-15', qty: 1000 },
      { sym: 'TLKM', type: 'buy', date: '2024-02-01', qty: 2500 },
      { sym: 'ASII', type: 'buy', date: '2024-02-20', qty: 1500 },
      { sym: 'BBCA', type: 'buy', date: '2024-03-11', qty: 500 },
      { sym: 'BBRI', type: 'buy', date: '2024-06-03', qty: 2000 },
      { sym: 'BBCA', type: 'sell', date: '2024-08-15', qty: 500 },
      { sym: 'UNVR', type: 'buy', date: '2025-01-13', qty: 3000 },
      { sym: 'TLKM', type: 'sell', date: '2025-05-20', qty: 1000 },
      { sym: 'GOTO', type: 'buy', date: '2025-07-01', qty: 100000 },
    ];
    for (const t of idxTrades) {
      const date = businessDays(t.date, addDays(t.date, 6))[0];
      const price = px(t.sym, date);
      // Typical IDX broker fees: ~0.15% buy, ~0.25% sell (incl. tax) — demo assumption
      await addTx(pIdx, { ...t, date, price, fee: Math.round(t.qty * price * (t.type === 'buy' ? 0.0015 : 0.0025)) });
    }
    await addTx(pIdx, { sym: 'BBCA', type: 'dividend', date: '2024-04-02', total: 1500 * 227 });
    await addTx(pIdx, { sym: 'BBCA', type: 'dividend', date: '2025-04-07', total: 1000 * 270 });
    await addTx(pIdx, { sym: 'TLKM', type: 'dividend', date: '2025-06-10', total: 1500 * 180 });

    const pUs = uuidv4();
    await client.query(
      `INSERT INTO portfolios (id, user_id, name, description, base_currency, cost_basis_method)
       VALUES ($1,$2,'Demo US Equities (IDR base)','Demonstration multi-currency portfolio with cash tracking','IDR','FIFO')`, [pUs, U.personal],
    );
    await addTx(pUs, { type: 'deposit', date: '2024-03-01', total: 900_000_000, currency: 'IDR' });
    await addTx(pUs, { type: 'deposit', date: '2024-08-30', total: 250_000_000, currency: 'IDR' });
    for (const t of [
      { sym: 'AAPL', type: 'buy', date: '2024-03-04', qty: 120 },
      { sym: 'MSFT', type: 'buy', date: '2024-03-05', qty: 60 },
      { sym: 'NVDA', type: 'buy', date: '2024-09-03', qty: 150 },
      { sym: 'MSFT', type: 'buy', date: '2025-02-03', qty: 20 },
      { sym: 'MSFT', type: 'sell', date: '2025-08-04', qty: 50 },
    ]) {
      const date = businessDays(t.date, addDays(t.date, 6))[0];
      await addTx(pUs, { ...t, date, price: px(t.sym, date), fee: 1 });
    }
    await addTx(pUs, { sym: 'AAPL', type: 'dividend', date: '2025-02-14', total: 120 * 0.25 });
    await addTx(pUs, { type: 'withdrawal', date: '2025-09-01', total: 10_000_000, currency: 'IDR' });
    await addTx(pUs, { type: 'fee', date: '2025-12-31', total: 150_000, currency: 'IDR', notes: 'Annual custody fee (demo)' });

    const pSim = uuidv4();
    await client.query(
      `INSERT INTO portfolios (id, user_id, name, description, base_currency, cost_basis_method, portfolio_type)
       VALUES ($1,$2,'Paper Trading (Simulasi)','Simulated trades — never real executions','IDR','WAC','simulation')`, [pSim, U.personal],
    );
    await addTx(pSim, { type: 'deposit', date: '2025-06-02', total: 50_000_000, simulated: true });
    const simDate = businessDays('2025-06-02', '2025-06-10')[0];
    await addTx(pSim, { sym: 'BBRI', type: 'buy', date: simDate, qty: 5000, price: px('BBRI', simDate), fee: 0, simulated: true });

    const pOrg = uuidv4();
    await client.query(
      `INSERT INTO portfolios (id, user_id, org_id, name, description, base_currency, cost_basis_method)
       VALUES ($1,$2,$3,'Kas Investasi Perusahaan (Demo)','Organisation-owned demo portfolio','IDR','WAC')`, [pOrg, U.owner, org1],
    );
    for (const t of [{ sym: 'BBRI', type: 'buy', date: '2025-03-03', qty: 10000 }, { sym: 'TLKM', type: 'buy', date: '2025-03-04', qty: 8000 }]) {
      const date = businessDays(t.date, addDays(t.date, 6))[0];
      const price = px(t.sym, date);
      await addTx(pOrg, { ...t, date, price, fee: Math.round(t.qty * price * 0.0015) });
    }

    const wl = uuidv4();
    await client.query("INSERT INTO watchlists (id, user_id, name) VALUES ($1,$2,'Saham Pilihan (Demo)')", [wl, U.personal]);
    for (const s of ['BBCA', 'BBRI', 'TLKM', 'AAPL', 'NVDA']) {
      await client.query('INSERT INTO watchlist_items (id, watchlist_id, instrument_id) VALUES ($1,$2,$3)', [uuidv4(), wl, inst[s].id]);
    }

    // ── Franchise structure ────────────────────────────────────────────────
    const b1 = uuidv4(); const b2 = uuidv4(); const r1 = uuidv4(); const r2 = uuidv4();
    await client.query(
      `INSERT INTO brands (id, org_id, name, code, description) VALUES
        ($1,$3,'Warung Kopi Nusantara','WKN','Coffee franchise (demo)'),
        ($2,$3,'Mie Ayam Berkah','MAB','Noodle franchise (demo)')`, [b1, b2, org1],
    );
    await client.query(
      `INSERT INTO regions (id, org_id, name, code) VALUES ($1,$3,'Jabodetabek','JBD'), ($2,$3,'Jawa Barat','JABAR')`, [r1, r2, org1],
    );
    const outletDefs = [
      { code: 'WKN-JAKSEL', name: 'WKN Jakarta Selatan', brand: b1, region: r1, city: 'Jakarta Selatan', base: 1_650_000, opened: '2023-01-01' },
      { code: 'WKN-JAKPUS', name: 'WKN Jakarta Pusat', brand: b1, region: r1, city: 'Jakarta Pusat', base: 1_450_000, opened: '2023-03-01' },
      { code: 'WKN-BDG', name: 'WKN Bandung', brand: b1, region: r2, city: 'Bandung', base: 900_000, opened: '2023-06-01' },
      { code: 'MAB-DPK', name: 'MAB Depok', brand: b2, region: r1, city: 'Depok', base: 1_200_000, opened: '2023-02-01' },
      { code: 'MAB-BKS', name: 'MAB Bekasi', brand: b2, region: r1, city: 'Bekasi', base: 1_050_000, opened: '2023-08-01' },
    ];
    const outlets = [];
    for (const o of outletDefs) {
      const id = uuidv4();
      outlets.push({ id, ...o });
      await client.query(
        `INSERT INTO outlets (id, org_id, brand_id, region_id, name, code, city, province, opening_date, reporting_currency)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'IDR')`,
        [id, org1, o.brand, o.region, o.name, o.code, o.city, o.region === r1 ? 'DKI Jakarta / Jawa Barat' : 'Jawa Barat', o.opened],
      );
    }
    // Manager: Jabodetabek outlets only (Bandung stays out of scope). Staff: one outlet.
    for (const o of outlets.filter((x) => x.region === r1)) {
      await client.query("INSERT INTO outlet_assignments (id, outlet_id, user_id, role) VALUES ($1,$2,$3,'manager')", [uuidv4(), o.id, U.manager]);
    }
    await client.query("INSERT INTO outlet_assignments (id, outlet_id, user_id, role) VALUES ($1,$2,$3,'staff')", [uuidv4(), outlets[0].id, U.staff]);

    const { rows: catRows } = await client.query('SELECT id, code FROM expense_categories WHERE org_id IS NULL');
    const cat = Object.fromEntries(catRows.map((r) => [r.code, r.id]));

    // ── Sales, expenses, targets (≈7 months) ──────────────────────────────
    const firstMonth = new Date(`${today.slice(0, 7)}-01T00:00:00Z`);
    firstMonth.setUTCMonth(firstMonth.getUTCMonth() - 6);
    const salesStart = iso(firstMonth);
    for (const o of outlets) {
      const dates = []; const gross = []; const disc = []; const ret = []; const tx = [];
      const monthly = {};
      for (let d = salesStart; d <= today; d = addDays(d, 1)) {
        const wd = new Date(`${d}T00:00:00Z`).getUTCDay();
        const factor = wd === 0 ? 0.65 : wd === 6 ? 1.25 : 1;
        const g = Math.round((o.base * factor * (0.85 + rand() * 0.3)) / 1000) * 1000;
        const dc = Math.round(g * (0.02 + rand() * 0.02) / 100) * 100;
        const rt = rand() < 0.05 ? Math.round(g * 0.01 / 100) * 100 : 0;
        dates.push(d); gross.push(g); disc.push(dc); ret.push(rt); tx.push(Math.max(1, Math.round(g / (o.brand === b1 ? 42000 : 30000))));
        const m = d.slice(0, 7);
        monthly[m] = (monthly[m] || 0) + g - dc - rt;
      }
      await client.query(
        `INSERT INTO sales_records (id, outlet_id, sale_date, gross_sales, discounts, returns, transaction_count, currency, created_by, source)
         SELECT gen_random_uuid(), $1, d::date, g, dc, r, t, 'IDR', $2, 'demo_seed'
           FROM unnest($3::text[], $4::numeric[], $5::numeric[], $6::numeric[], $7::int[]) AS x(d, g, dc, r, t)`,
        [o.id, U.owner, dates, gross, disc, ret, tx],
      );
      for (const [m, net] of Object.entries(monthly)) {
        const [y, mo] = m.split('-').map(Number);
        const lastDay = iso(new Date(Date.UTC(y, mo, 0)));
        const expDate = lastDay > today ? today : lastDay;
        // Fixed monthly costs are pro-rated for the current, incomplete month.
        const share = lastDay > today ? Number(today.slice(8, 10)) / Number(lastDay.slice(8, 10)) : 1;
        const fixed = (v) => Math.round(v * share);
        const rent = o.city === 'Bandung' ? 7_500_000 : 6_000_000;
        for (const [code, amt] of [
          ['COGS', Math.round(net * (o.brand === b1 ? 0.34 : 0.38))], ['STAFF', fixed(9_000_000)], ['RENT', fixed(rent)],
          ['UTIL', fixed(1_800_000 + Math.round(rand() * 400_000))], ['MKT', fixed(1_200_000)], ['OTHER_OP', fixed(450_000)], ['TAX', Math.round(net * 0.005)],
        ]) {
          await client.query(
            `INSERT INTO operating_expenses (id, outlet_id, expense_category_id, expense_date, amount, currency, created_by, source, description)
             VALUES ($1,$2,$3,$4,$5,'IDR',$6,'demo_seed',$7)`,
            [uuidv4(), o.id, cat[code], expDate, amt, U.owner, `Demo ${code} ${m}`],
          );
        }
        await client.query(
          `INSERT INTO targets (id, org_id, outlet_id, target_type, period_type, period_year, period_value, target_amount, currency, created_by)
           VALUES ($1,$2,$3,'sales','monthly',$4,$5,$6,'IDR',$7)`,
          [uuidv4(), org1, o.id, y, mo, Math.round(o.base * 30 * 1.05 / 100000) * 100000, U.owner],
        );
      }
    }

    // ── Products and inventory (movements first, balances derived) ────────
    const products = [
      { sku: 'KPI-001', name: 'Biji Kopi Arabica 1kg', unit: 'kg', cost: 180000, price: 0, reorder: 8 },
      { sku: 'KPI-002', name: 'Susu UHT 1L', unit: 'liter', cost: 18000, price: 0, reorder: 40 },
      { sku: 'BKR-001', name: 'Croissant Beku', unit: 'pcs', cost: 8000, price: 22000, reorder: 60 },
      { sku: 'MAB-001', name: 'Mie Telur Mentah', unit: 'kg', cost: 32000, price: 0, reorder: 20 },
      { sku: 'PKG-001', name: 'Cup Kertas 12oz', unit: 'pcs', cost: 900, price: 0, reorder: 500 },
    ];
    const pid = {};
    for (const p of products) {
      pid[p.sku] = uuidv4();
      await client.query(
        `INSERT INTO products (id, org_id, sku, name, unit, unit_cost, unit_price, currency, reorder_level)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'IDR',$8)`,
        [pid[p.sku], org1, p.sku, p.name, p.unit, p.cost, p.price || null, p.reorder],
      );
    }
    const invStart = addDays(today, -60);
    for (const o of outlets) {
      for (const p of products) {
        if (o.brand === b1 && p.sku === 'MAB-001') continue;
        if (o.brand === b2 && ['KPI-001', 'BKR-001'].includes(p.sku)) continue;
        let bal = 0;
        const receive = p.reorder * 6;
        const moves = [['receive', receive, invStart, 'Opening stock (demo)']];
        bal += receive;
        for (let w = 1; w <= 8; w++) {
          // Bandung runs down its stock faster so the demo shows low-stock alerts.
          const use = Math.round(p.reorder * (o.code === 'WKN-BDG' ? 0.7 + rand() * 0.2 : 0.3 + rand() * 0.4));
          if (bal - use < 0) break;
          moves.push(['issue', -use, addDays(invStart, w * 7), 'Weekly usage (demo)']);
          bal -= use;
        }
        for (const [type, q, date, notes] of moves) {
          await client.query(
            `INSERT INTO inventory_movements (id, outlet_id, product_id, movement_type, quantity, unit_cost, total_cost, moved_by, movement_date, notes)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
            [uuidv4(), o.id, pid[p.sku], type, q, p.cost, Math.abs(q) * p.cost, U.owner, date, notes],
          );
        }
        await client.query(
          'INSERT INTO inventory_balances (id, outlet_id, product_id, quantity) VALUES ($1,$2,$3,$4)',
          [uuidv4(), o.id, pid[p.sku], bal],
        );
      }
    }

    // ── Second tenant (isolation demo) ────────────────────────────────────
    const b3 = uuidv4(); const o3 = uuidv4();
    await client.query("INSERT INTO brands (id, org_id, name, code) VALUES ($1,$2,'Bakso Rejeki','BKR')", [b3, org2]);
    await client.query(
      `INSERT INTO outlets (id, org_id, brand_id, name, code, city, opening_date) VALUES ($1,$2,$3,'Bakso Rejeki Malang','BKR-MLG','Malang','2024-01-01')`,
      [o3, org2, b3],
    );
    const d2 = []; const g2 = [];
    for (let d = addDays(today, -60); d <= today; d = addDays(d, 1)) { d2.push(d); g2.push(Math.round(700000 + rand() * 300000)); }
    await client.query(
      `INSERT INTO sales_records (id, outlet_id, sale_date, gross_sales, transaction_count, created_by, source)
       SELECT gen_random_uuid(), $1, d::date, g, 25, $2, 'demo_seed' FROM unnest($3::text[], $4::numeric[]) AS x(d, g)`,
      [o3, U.owner2, d2, g2],
    );

    await client.query('COMMIT');
    console.log('\nSeeding complete.\n');
    console.log(`Demo accounts (development only) — password: ${DEMO_PASSWORD}`);
    console.log('  superadmin@demo.local  Platform superadmin (no tenant financial access)');
    console.log('  owner@demo.local       Owner of "PT Demo Franchise" (stocks + franchise)');
    console.log('  manager@demo.local     Manager — 4 Jabodetabek outlets only');
    console.log('  staff@demo.local       Staff — WKN Jakarta Selatan only, no profit figures');
    console.log('  personal@demo.local    Personal investor — 3 portfolios incl. a simulation');
    console.log('  owner2@demo.local      Owner of a second, isolated organisation\n');
    console.log('All prices, sales and financial figures are DEMONSTRATION data.');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

seed().catch((err) => { console.error('Seed failed:', err.message); process.exit(1); });
