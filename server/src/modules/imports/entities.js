/**
 * Import entity definitions.
 *
 * Each entity declares its fields (with header aliases for auto-mapping),
 * how to authorise the import context, how to validate/normalise one row,
 * how to detect duplicates, and how to insert it inside a transaction.
 *
 * Duplicate detection uses a SHA-256 fingerprint of the normalised business
 * fields (source_hash). The same row imported twice — from the same or a
 * different file — is skipped, so re-processing a file never duplicates data.
 */
import { createHash } from 'crypto';
import Decimal from 'decimal.js';
import { query } from '../../config/database.js';
import { AppError } from '../../utils/errors.js';
import { PERMISSIONS as P, franchiseContext } from '../../services/permissions.js';
import { getPortfolio } from '../stocks/portfolio.service.js';
import { prepareTransaction } from '../stocks/transaction.service.js';
import { applyMovement, MOVEMENT_TYPES } from '../franchise/inventory.service.js';
import { parseNumber, parseDate } from './parsers.js';
import { todayIn } from '../../utils/dates.js';
import { randomUUID as uuidv4 } from 'crypto';

export function fingerprint(entity, parts) {
  return createHash('sha256').update([entity, ...parts.map((p) => (p == null ? '' : String(p)))].join('|')).digest('hex');
}

/** Canonical decimal string ('100.000' and '100' fingerprint identically). */
const nz = (v) => (v == null || v === '' ? '' : new Decimal(v).toString());

class RowError extends Error {
  constructor(column, message, code = 'INVALID') { super(message); this.column = column; this.code = code; }
}

function num(row, key, { required = false, min = null, integer = false } = {}) {
  const raw = row[key];
  const v = parseNumber(raw);
  if (v === null) { if (required) throw new RowError(key, `${key} is required`, 'REQUIRED'); return null; }
  if (Number.isNaN(v)) throw new RowError(key, `${key} "${raw}" is not a number`, 'NOT_A_NUMBER');
  const d = new Decimal(v);
  if (min !== null && d.lt(min)) throw new RowError(key, `${key} must be ≥ ${min}`, 'OUT_OF_RANGE');
  if (integer && !d.isInteger()) throw new RowError(key, `${key} must be a whole number`, 'NOT_INTEGER');
  return d;
}

function date(row, key, tz) {
  const v = parseDate(row[key]);
  if (v === null) throw new RowError(key, `${key} is required`, 'REQUIRED');
  if (v === 'invalid') throw new RowError(key, `${key} "${row[key]}" is not a valid date (use YYYY-MM-DD or DD/MM/YYYY)`, 'INVALID_DATE');
  if (v > todayIn(tz)) throw new RowError(key, `${key} is in the future`, 'FUTURE_DATE');
  return v;
}

function text(row, key, { required = false, max = 255 } = {}) {
  const v = row[key] == null ? '' : String(row[key]).trim();
  if (!v && required) throw new RowError(key, `${key} is required`, 'REQUIRED');
  if (v.length > max) throw new RowError(key, `${key} is too long`, 'TOO_LONG');
  // Spreadsheet formula prefixes are stored as plain text, never interpreted.
  return v || null;
}

// ── Franchise context helpers ────────────────────────────────────────────────

async function franchiseImportContext(req, { orgId }, permission) {
  const { membership, scope } = await franchiseContext(req, orgId, permission);
  const params = [orgId];
  let where = 'org_id = $1 AND deleted_at IS NULL';
  if (!scope.all) { params.push(scope.outletIds); where += ' AND id = ANY($2::uuid[])'; }
  const { rows } = await query(`SELECT id, code, name FROM outlets WHERE ${where}`, params);
  const outlets = new Map();
  for (const o of rows) {
    if (o.code) outlets.set(o.code.toUpperCase(), o);
    outlets.set(o.name.toUpperCase(), o);
  }
  return { orgId, timezone: membership.default_timezone, outlets, userId: req.user.id };
}

function outletOf(ctx, row) {
  const key = text(row, 'outlet_code', { required: true });
  const outlet = ctx.outlets.get(key.toUpperCase());
  if (!outlet) throw new RowError('outlet_code', `Outlet "${key}" not found or not in your scope`, 'UNKNOWN_OUTLET');
  return outlet;
}

// ── Entity definitions ───────────────────────────────────────────────────────

export const ENTITIES = {
  sales: {
    module: 'franchise',
    label: 'Daily sales',
    context: ['orgId'],
    fields: [
      { key: 'outlet_code', required: true, aliases: ['outlet', 'kode outlet', 'outlet code', 'kode_outlet', 'store'] },
      { key: 'date', required: true, aliases: ['sale_date', 'tanggal', 'tgl'] },
      { key: 'gross_sales', required: true, aliases: ['gross', 'penjualan kotor', 'omzet', 'total'] },
      { key: 'discounts', aliases: ['discount', 'diskon'] },
      { key: 'returns', aliases: ['refunds', 'retur'] },
      { key: 'transaction_count', aliases: ['transactions', 'jumlah transaksi', 'trx', 'tx_count'] },
      { key: 'notes', aliases: ['catatan', 'note'] },
    ],
    loadContext: (req, c) => franchiseImportContext(req, c, P.SALES_WRITE),
    async validate(row, ctx) {
      const outlet = outletOf(ctx, row);
      const d = date(row, 'date', ctx.timezone);
      const gross = num(row, 'gross_sales', { required: true, min: 0 });
      const disc = num(row, 'discounts', { min: 0 }) || new Decimal(0);
      const ret = num(row, 'returns', { min: 0 }) || new Decimal(0);
      const tx = num(row, 'transaction_count', { min: 0, integer: true }) || new Decimal(0);
      if (disc.plus(ret).gt(gross)) throw new RowError('discounts', 'discounts + returns exceed gross_sales', 'INCONSISTENT');
      const record = {
        outlet_id: outlet.id, sale_date: d, gross_sales: gross.toFixed(2), discounts: disc.toFixed(2),
        returns: ret.toFixed(2), transaction_count: tx.toNumber(), notes: text(row, 'notes', { max: 2000 }),
      };
      const hash = fingerprint('sales', [record.outlet_id, d, record.gross_sales, record.discounts, record.returns, record.transaction_count]);
      return { record, hash, display: { outlet: outlet.code || outlet.name, date: d, gross: record.gross_sales } };
    },
    async existing(records) {
      if (!records.length) return new Set();
      const { rows } = await query(
        `SELECT outlet_id, sale_date, gross_sales, discounts, returns, transaction_count, source_hash
           FROM sales_records WHERE deleted_at IS NULL AND outlet_id = ANY($1::uuid[]) AND sale_date = ANY($2::date[])`,
        [[...new Set(records.map((r) => r.record.outlet_id))], [...new Set(records.map((r) => r.record.sale_date))]],
      );
      return new Set(rows.map((r) => r.source_hash || fingerprint('sales', [r.outlet_id, r.sale_date, new Decimal(r.gross_sales).toFixed(2), new Decimal(r.discounts).toFixed(2), new Decimal(r.returns).toFixed(2), r.transaction_count])));
    },
    async insert(client, { record, hash }, ctx, batchId) {
      const { rowCount } = await client.query(
        `INSERT INTO sales_records (id, outlet_id, sale_date, gross_sales, discounts, returns, transaction_count,
                                    currency, notes, source, import_batch_id, source_hash, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'IDR',$8,'import',$9,$10,$11) ON CONFLICT DO NOTHING`,
        [uuidv4(), record.outlet_id, record.sale_date, record.gross_sales, record.discounts, record.returns,
          record.transaction_count, record.notes, batchId, hash, ctx.userId],
      );
      return rowCount > 0;
    },
  },

  expenses: {
    module: 'franchise',
    label: 'Expenses',
    context: ['orgId'],
    fields: [
      { key: 'outlet_code', required: true, aliases: ['outlet', 'kode outlet', 'kode_outlet'] },
      { key: 'date', required: true, aliases: ['expense_date', 'tanggal', 'tgl'] },
      { key: 'category', required: true, aliases: ['category_code', 'kategori', 'akun'] },
      { key: 'amount', required: true, aliases: ['jumlah', 'nominal', 'biaya'] },
      { key: 'description', aliases: ['keterangan', 'deskripsi'] },
      { key: 'reference', aliases: ['ref', 'no_bukti', 'invoice'] },
    ],
    async loadContext(req, c) {
      const ctx = await franchiseImportContext(req, c, P.EXPENSES_WRITE);
      const { rows } = await query('SELECT id, code, name FROM expense_categories WHERE is_active AND (org_id IS NULL OR org_id = $1)', [c.orgId]);
      ctx.categories = new Map();
      for (const r of rows) {
        if (r.code) ctx.categories.set(r.code.toUpperCase(), r);
        ctx.categories.set(r.name.toUpperCase(), r);
      }
      return ctx;
    },
    async validate(row, ctx) {
      const outlet = outletOf(ctx, row);
      const d = date(row, 'date', ctx.timezone);
      const catKey = text(row, 'category', { required: true });
      const cat = ctx.categories.get(catKey.toUpperCase());
      if (!cat) throw new RowError('category', `Expense category "${catKey}" not found`, 'UNKNOWN_CATEGORY');
      const amount = num(row, 'amount', { required: true, min: 0 });
      const record = {
        outlet_id: outlet.id, expense_category_id: cat.id, expense_date: d, amount: amount.toFixed(2),
        description: text(row, 'description', { max: 2000 }), reference: text(row, 'reference'),
      };
      const hash = fingerprint('expenses', [record.outlet_id, cat.id, d, record.amount, record.reference || '', record.description || '']);
      return { record, hash, display: { outlet: outlet.code || outlet.name, date: d, category: cat.code || cat.name, amount: record.amount } };
    },
    async existing(records) {
      if (!records.length) return new Set();
      const { rows } = await query(
        `SELECT source_hash FROM operating_expenses WHERE deleted_at IS NULL AND source_hash = ANY($1::text[])`,
        [records.map((r) => r.hash)],
      );
      return new Set(rows.map((r) => r.source_hash));
    },
    async insert(client, { record, hash }, ctx, batchId) {
      const { rowCount } = await client.query(
        `INSERT INTO operating_expenses (id, outlet_id, expense_category_id, expense_date, amount, currency, description,
                                         reference, source, import_batch_id, source_hash, created_by)
         VALUES ($1,$2,$3,$4,$5,'IDR',$6,$7,'import',$8,$9,$10) ON CONFLICT DO NOTHING`,
        [uuidv4(), record.outlet_id, record.expense_category_id, record.expense_date, record.amount,
          record.description, record.reference, batchId, hash, ctx.userId],
      );
      return rowCount > 0;
    },
  },

  inventory: {
    module: 'franchise',
    label: 'Inventory movements',
    context: ['orgId'],
    fields: [
      { key: 'outlet_code', required: true, aliases: ['outlet', 'kode outlet'] },
      { key: 'date', required: true, aliases: ['movement_date', 'tanggal'] },
      { key: 'sku', required: true, aliases: ['product', 'kode produk', 'product_sku'] },
      { key: 'movement_type', required: true, aliases: ['type', 'jenis'] },
      { key: 'quantity', required: true, aliases: ['qty', 'jumlah'] },
      { key: 'unit_cost', aliases: ['cost', 'harga pokok', 'hpp'] },
      { key: 'notes', aliases: ['catatan', 'keterangan'] },
    ],
    async loadContext(req, c) {
      const ctx = await franchiseImportContext(req, c, P.INVENTORY_WRITE);
      const { rows } = await query('SELECT id, sku, name FROM products WHERE org_id = $1 AND deleted_at IS NULL', [c.orgId]);
      ctx.products = new Map(rows.filter((r) => r.sku).map((r) => [r.sku.toUpperCase(), r]));
      return ctx;
    },
    async validate(row, ctx) {
      const outlet = outletOf(ctx, row);
      const d = date(row, 'date', ctx.timezone);
      const sku = text(row, 'sku', { required: true });
      const product = ctx.products.get(sku.toUpperCase());
      if (!product) throw new RowError('sku', `Product SKU "${sku}" not found`, 'UNKNOWN_PRODUCT');
      const type = String(row.movement_type || '').trim().toLowerCase();
      const allowed = MOVEMENT_TYPES.filter((t) => !t.startsWith('transfer'));
      if (!allowed.includes(type)) throw new RowError('movement_type', `movement_type must be one of ${allowed.join(', ')}`, 'INVALID_TYPE');
      const qty = num(row, 'quantity', { required: true });
      if (qty.isZero() || (type !== 'adjustment' && qty.lt(0))) throw new RowError('quantity', 'quantity must be positive (adjustments may be negative)', 'OUT_OF_RANGE');
      const notes = text(row, 'notes', { max: 1000 });
      if (type === 'adjustment' && !notes) throw new RowError('notes', 'adjustments require notes', 'REQUIRED');
      const unitCost = num(row, 'unit_cost', { min: 0 });
      const record = { outletId: outlet.id, productId: product.id, movementType: type, quantity: qty.toString(), unitCost: unitCost?.toString() ?? null, movementDate: d, notes };
      const hash = fingerprint('inventory', [outlet.id, product.id, type, d, qty.toString(), unitCost?.toString() ?? '', notes || '']);
      return { record, hash, display: { outlet: outlet.code || outlet.name, date: d, sku, type, quantity: qty.toString() } };
    },
    async existing(records) {
      if (!records.length) return new Set();
      const { rows } = await query('SELECT source_hash FROM inventory_movements WHERE source_hash = ANY($1::text[])', [records.map((r) => r.hash)]);
      return new Set(rows.map((r) => r.source_hash));
    },
    async insert(client, { record, hash }, ctx, batchId) {
      // Savepoint so an insufficient-stock row does not abort the whole batch.
      await client.query('SAVEPOINT inv_row');
      try {
        const r = await applyMovement(client, { ...record, userId: ctx.userId, sourceHash: hash, importBatchId: batchId, referenceType: 'import' });
        await client.query('RELEASE SAVEPOINT inv_row');
        return !r.duplicate;
      } catch (err) {
        await client.query('ROLLBACK TO SAVEPOINT inv_row');
        throw err;
      }
    },
    sortKey: (r) => r.record.movementDate,
  },

  stock_transactions: {
    module: 'stocks',
    label: 'Stock transactions / broker statement',
    context: ['portfolioId'],
    fields: [
      { key: 'date', required: true, aliases: ['transaction_date', 'tanggal', 'trade date', 'trade_date'] },
      { key: 'type', required: true, aliases: ['transaction_type', 'jenis', 'side', 'action'] },
      { key: 'symbol', aliases: ['ticker', 'kode saham', 'stock', 'kode'] },
      { key: 'exchange', aliases: ['bursa', 'market'] },
      { key: 'quantity', aliases: ['qty', 'shares', 'lembar', 'volume'] },
      { key: 'price', aliases: ['harga', 'execution price'] },
      { key: 'fee', aliases: ['fees', 'commission', 'biaya', 'komisi'] },
      { key: 'amount', aliases: ['total_amount', 'total', 'nominal'] },
      { key: 'currency', aliases: ['mata uang', 'ccy'] },
      { key: 'exchange_rate', aliases: ['fx', 'fx_rate', 'kurs'] },
      { key: 'reference', aliases: ['ref', 'order id', 'trade id'] },
      { key: 'notes', aliases: ['catatan'] },
    ],
    async loadContext(req, { portfolioId }) {
      const portfolio = await getPortfolio(portfolioId, req, { write: true });
      const { rows } = await query(
        `SELECT i.id, i.symbol, e.code AS exchange_code FROM instruments i JOIN exchanges e ON e.id = i.exchange_id WHERE i.is_active`,
      );
      const bySymbol = new Map();
      for (const i of rows) {
        const list = bySymbol.get(i.symbol.toUpperCase()) || [];
        list.push(i);
        bySymbol.set(i.symbol.toUpperCase(), list);
      }
      return { portfolio, bySymbol, userId: req.user.id, orgId: portfolio.org_id };
    },
    async validate(row, ctx, { skipHoldingCheck = true } = {}) {
      const typeMap = { b: 'buy', beli: 'buy', buy: 'buy', s: 'sell', jual: 'sell', sell: 'sell', dividen: 'dividend', dividend: 'dividend',
        deposit: 'deposit', setor: 'deposit', withdrawal: 'withdrawal', tarik: 'withdrawal', fee: 'fee', biaya: 'fee', split: 'split' };
      const rawType = String(row.type || '').trim().toLowerCase();
      const type = typeMap[rawType];
      if (!type) throw new RowError('type', `Unknown transaction type "${row.type}"`, 'INVALID_TYPE');
      const d = date(row, 'date');
      let instrumentId = null;
      if (['buy', 'sell', 'dividend', 'split'].includes(type)) {
        const sym = text(row, 'symbol', { required: true }).toUpperCase().replace(/\.JK$/, '');
        let candidates = ctx.bySymbol.get(sym) || [];
        if (row.exchange) candidates = candidates.filter((c) => c.exchange_code === String(row.exchange).trim().toUpperCase());
        if (!candidates.length) throw new RowError('symbol', `Instrument "${sym}" is not supported`, 'UNKNOWN_INSTRUMENT');
        if (candidates.length > 1) throw new RowError('exchange', `"${sym}" is listed on several exchanges — add an exchange column`, 'AMBIGUOUS');
        instrumentId = candidates[0].id;
      }
      const n = (k) => { const v = parseNumber(row[k]); if (Number.isNaN(v)) throw new RowError(k, `${k} "${row[k]}" is not a number`, 'NOT_A_NUMBER'); return v; };
      const input = {
        transactionType: type, transactionDate: d, instrumentId,
        quantity: n('quantity'), price: n('price'), fee: n('fee') ?? 0, totalAmount: n('amount'),
        currency: row.currency ? String(row.currency).trim().toUpperCase() : undefined,
        exchangeRate: n('exchange_rate'), reference: text(row, 'reference'), notes: text(row, 'notes', { max: 2000 }),
      };
      let record;
      try {
        record = await prepareTransaction(ctx.portfolio, input, { skipHoldingCheck });
      } catch (err) {
        throw new RowError(null, err.message, 'REJECTED');
      }
      const hash = fingerprint('stock_tx', [ctx.portfolio.id, type, d, instrumentId, nz(record.quantity), nz(record.price), nz(record.total_amount), nz(record.fee), record.reference || '']);
      return { record, hash, input, display: { date: d, type, symbol: row.symbol || '', quantity: record.quantity, amount: record.total_amount } };
    },
    async existing(records, ctx) {
      if (!records.length) return new Set();
      const { rows } = await query(
        `SELECT source_hash, transaction_type, transaction_date, instrument_id, quantity, price, total_amount, fee, reference
           FROM portfolio_transactions WHERE portfolio_id = $1 AND deleted_at IS NULL`, [ctx.portfolio.id],
      );
      return new Set(rows.map((r) => r.source_hash || fingerprint('stock_tx', [ctx.portfolio.id, r.transaction_type, r.transaction_date, r.instrument_id, nz(r.quantity), nz(r.price), nz(r.total_amount), nz(r.fee), r.reference || ''])));
    },
    async insert(client, { record, hash, input }, ctx, batchId) {
      // Re-validate the holding inside the transaction so earlier rows of the same file count.
      if (record.transaction_type === 'sell') {
        const { rows } = await client.query(
          `SELECT transaction_type, quantity FROM portfolio_transactions
            WHERE portfolio_id = $1 AND instrument_id = $2 AND deleted_at IS NULL AND transaction_date <= $3
            ORDER BY transaction_date, created_at`, [ctx.portfolio.id, record.instrument_id, record.transaction_date],
        );
        let q = new Decimal(0);
        for (const r of rows) {
          if (r.transaction_type === 'buy') q = q.plus(r.quantity);
          else if (r.transaction_type === 'sell') q = q.minus(r.quantity);
          else if (r.transaction_type === 'split') q = q.times(r.quantity);
        }
        if (new Decimal(record.quantity).gt(q)) throw new AppError(`Cannot sell ${record.quantity}: only ${q} held on ${record.transaction_date}.`, 422);
      }
      const cols = ['instrument_id', 'transaction_type', 'transaction_date', 'transaction_time', 'quantity', 'price', 'total_amount', 'fee', 'currency', 'exchange_rate', 'base_amount', 'notes', 'reference', 'is_simulated'];
      const { rowCount } = await client.query(
        `INSERT INTO portfolio_transactions (id, portfolio_id, import_batch_id, source_hash, ${cols.join(', ')})
         VALUES ($1,$2,$3,$4, ${cols.map((_, i) => `$${i + 5}`).join(', ')}) ON CONFLICT DO NOTHING`,
        [uuidv4(), ctx.portfolio.id, batchId, hash, ...cols.map((c) => record[c])],
      );
      return rowCount > 0;
    },
    sortKey: (r) => `${r.record.transaction_date}|${r.record.transaction_type === 'sell' ? 1 : 0}`,
  },
};

export { RowError };

export function suggestMapping(entity, headers) {
  const def = ENTITIES[entity];
  const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const mapping = {};
  for (const f of def.fields) {
    const candidates = [f.key, ...(f.aliases || [])].map(norm);
    const match = headers.find((h) => candidates.includes(norm(h)));
    if (match) mapping[f.key] = match;
  }
  return mapping;
}

export function templateCsv(entity) {
  const def = ENTITIES[entity];
  if (!def) throw new AppError('Unknown import type.', 404);
  const examples = {
    sales: ['WKN-JAKSEL', '2026-01-31', '1500000', '45000', '0', '23', ''],
    expenses: ['WKN-JAKSEL', '2026-01-31', 'RENT', '6000000', 'Sewa Januari', 'INV-001'],
    inventory: ['WKN-JAKSEL', '2026-01-31', 'KPI-001', 'receive', '50', '12000', ''],
    stock_transactions: ['2026-01-15', 'buy', 'BBCA', 'IDX', '100', '9500', '47500', '', 'IDR', '', 'TRX-1', ''],
  };
  return `${def.fields.map((f) => f.key).join(',')}\n${examples[entity].join(',')}\n`;
}
