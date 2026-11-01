/**
 * GET /api/v1/exports/:dataset?format=csv|xlsx|pdf&...filters
 *
 * Every dataset re-uses the same authorisation and query code as the
 * corresponding on-screen view, so an export can never reveal more than the
 * user can already see. Exports are audited.
 */
import express from 'express';
import { requireAuth } from '../../middleware/auth.js';
import { query } from '../../config/database.js';
import { AppError } from '../../utils/errors.js';
import { audit } from '../audit/audit.service.js';
import { PERMISSIONS as P, requirePermission, isUuid } from '../../services/permissions.js';
import { config } from '../../config/env.js';
import { render } from './export.service.js';
import { readFranchiseFilter } from '../franchise/franchise.routes.js';
import { monthlyPnl, outletComparison } from '../franchise/franchise.service.js';
import { scopedOutletWhere } from '../franchise/records.shared.js';
import { transactionWhere } from '../stocks/transaction.routes.js';
import { getPortfolio, getPortfolioHoldings } from '../stocks/portfolio.service.js';
import { isIsoDate } from '../../utils/dates.js';

const router = express.Router();
router.use(requireAuth);

const MAX_ROWS = 50000;
const DEMO_NOTE = 'DEMONSTRATION DATA — not real market prices or financial records.';

function requireExport(req, orgId) {
  requirePermission(req, orgId, P.DATA_EXPORT);
}

const DATASETS = {
  async 'stock-transactions'(req) {
    if (req.query.portfolioId) await getPortfolio(req.query.portfolioId, req);
    const { where, params } = await transactionWhere(req);
    const { rows } = await query(
      `SELECT pt.transaction_date, pt.transaction_type, i.symbol, e.code AS exchange, pt.quantity, pt.price, pt.fee,
              pt.total_amount, pt.currency, pt.exchange_rate, pt.base_amount, p.base_currency, p.name AS portfolio,
              pt.reference, pt.notes, pt.is_demo, pt.is_simulated
         FROM portfolio_transactions pt JOIN portfolios p ON p.id = pt.portfolio_id
         LEFT JOIN instruments i ON i.id = pt.instrument_id LEFT JOIN exchanges e ON e.id = i.exchange_id
        WHERE ${where} ORDER BY pt.transaction_date, pt.created_at LIMIT ${MAX_ROWS}`,
      params,
    );
    return {
      title: 'Stock transactions',
      demo: rows.some((r) => r.is_demo),
      columns: [
        { key: 'transaction_date', label: 'Date' }, { key: 'portfolio', label: 'Portfolio' }, { key: 'transaction_type', label: 'Type' },
        { key: 'symbol', label: 'Symbol' }, { key: 'exchange', label: 'Exchange' }, { key: 'quantity', label: 'Quantity', type: 'number' },
        { key: 'price', label: 'Price', type: 'number' }, { key: 'fee', label: 'Fee', type: 'money' },
        { key: 'total_amount', label: 'Amount', type: 'money' }, { key: 'currency', label: 'Ccy' },
        { key: 'exchange_rate', label: 'FX rate', type: 'number' }, { key: 'base_amount', label: 'Base amount', type: 'money' },
        { key: 'base_currency', label: 'Base ccy' }, { key: 'reference', label: 'Reference' }, { key: 'notes', label: 'Notes' },
        { key: 'is_simulated', label: 'Simulated' },
      ],
      rows,
    };
  },

  async 'stock-holdings'(req) {
    const { portfolio, holdings, summary } = await getPortfolioHoldings(req.query.portfolioId, req);
    return {
      title: `Holdings — ${portfolio.name}`,
      subtitle: `Base currency ${summary.baseCurrency} · cost basis ${summary.costBasisMethod} · total return ${summary.totalReturn}`,
      demo: summary.pricesAreDemo,
      columns: [
        { key: 'symbol', label: 'Symbol' }, { key: 'exchangeCode', label: 'Exchange' }, { key: 'openQty', label: 'Quantity', type: 'number' },
        { key: 'wac', label: 'Avg cost', type: 'number' }, { key: 'costBasis', label: 'Cost basis', type: 'money' },
        { key: 'priceInBase', label: 'Price (base)', type: 'number' }, { key: 'marketValue', label: 'Market value', type: 'money' },
        { key: 'unrealisedPnl', label: 'Unrealised P/L', type: 'money' }, { key: 'realisedPnl', label: 'Realised P/L', type: 'money' },
        { key: 'dividends', label: 'Dividends', type: 'money' }, { key: 'totalReturn', label: 'Total return', type: 'money' },
        { key: 'totalReturnPct', label: 'Return %', type: 'percent' }, { key: 'lastPriceAt', label: 'Price time' },
      ],
      rows: holdings.map((h) => ({ ...h, lastPriceAt: h.lastPriceAt ? new Date(h.lastPriceAt).toISOString() : '' })),
    };
  },

  async 'franchise-pnl'(req) {
    const { filter, period } = await readFranchiseFilter(req, P.FINANCIALS_READ, { defaultFrom: 'year' });
    requireExport(req, filter.orgId);
    const rows = await monthlyPnl(filter, period);
    return {
      title: 'Profit & loss by month', subtitle: `${period.from} – ${period.to} · IDR`, orgId: filter.orgId,
      columns: [
        { key: 'month', label: 'Month' }, { key: 'grossSales', label: 'Gross sales', type: 'money' },
        { key: 'discounts', label: 'Discounts', type: 'money' }, { key: 'returns', label: 'Returns', type: 'money' },
        { key: 'netSales', label: 'Net sales', type: 'money' }, { key: 'cogs', label: 'COGS', type: 'money' },
        { key: 'grossProfit', label: 'Gross profit', type: 'money' }, { key: 'grossMarginPct', label: 'Gross margin', type: 'percent' },
        { key: 'operatingExpenses', label: 'Opex', type: 'money' }, { key: 'operatingProfit', label: 'Operating profit', type: 'money' },
        { key: 'netProfit', label: 'Net profit', type: 'money' }, { key: 'netMarginPct', label: 'Net margin', type: 'percent' },
        { key: 'transactionCount', label: 'Transactions', type: 'number' },
      ],
      rows,
    };
  },

  async 'outlet-comparison'(req) {
    const { filter, period, canSeeFinancials } = await readFranchiseFilter(req);
    requireExport(req, filter.orgId);
    const rows = await outletComparison(filter, period, { includeFinancials: canSeeFinancials });
    const columns = [
      { key: 'code', label: 'Code' }, { key: 'name', label: 'Outlet' }, { key: 'brandName', label: 'Brand' }, { key: 'regionName', label: 'Region' },
      { key: 'netSales', label: 'Net sales', type: 'money' }, { key: 'transactionCount', label: 'Transactions', type: 'number' },
      { key: 'averageTransactionValue', label: 'ATV', type: 'money' }, { key: 'target', label: 'Target', type: 'money' },
      { key: 'achievementPct', label: 'Achievement', type: 'percent' }, { key: 'salesGrowthPct', label: 'Growth', type: 'percent' },
    ];
    if (canSeeFinancials) {
      columns.push({ key: 'grossProfit', label: 'Gross profit', type: 'money' }, { key: 'netProfit', label: 'Net profit', type: 'money' }, { key: 'netMarginPct', label: 'Net margin', type: 'percent' });
    }
    return { title: 'Outlet comparison', subtitle: `${period.from} – ${period.to}`, orgId: filter.orgId, columns, rows };
  },

  async sales(req) {
    const { where, params, from, to } = await scopedOutletWhere(req, P.FRANCHISE_READ);
    const orgId = await orgOf(req);
    requireExport(req, orgId);
    let w = `WHERE ${where} AND sr.deleted_at IS NULL`;
    if (from) { params.push(from); w += ` AND sr.sale_date >= $${params.length}`; }
    if (to) { params.push(to); w += ` AND sr.sale_date <= $${params.length}`; }
    const { rows } = await query(
      `SELECT sr.sale_date, o.code AS outlet_code, o.name AS outlet, sr.gross_sales, sr.discounts, sr.returns, sr.net_sales,
              sr.transaction_count, sr.source, sr.notes
         FROM sales_records sr JOIN outlets o ON o.id = sr.outlet_id ${w} ORDER BY sr.sale_date, o.name LIMIT ${MAX_ROWS}`, params,
    );
    return {
      title: 'Sales', orgId, demo: rows.some((r) => r.source === 'demo_seed'),
      columns: [
        { key: 'sale_date', label: 'Date' }, { key: 'outlet_code', label: 'Outlet code' }, { key: 'outlet', label: 'Outlet' },
        { key: 'gross_sales', label: 'Gross', type: 'money' }, { key: 'discounts', label: 'Discounts', type: 'money' },
        { key: 'returns', label: 'Returns', type: 'money' }, { key: 'net_sales', label: 'Net', type: 'money' },
        { key: 'transaction_count', label: 'Transactions', type: 'number' }, { key: 'source', label: 'Source' }, { key: 'notes', label: 'Notes' },
      ],
      rows,
    };
  },

  async expenses(req) {
    const { where, params, from, to } = await scopedOutletWhere(req, P.FRANCHISE_READ);
    const orgId = await orgOf(req);
    requireExport(req, orgId);
    let w = `WHERE ${where} AND oe.deleted_at IS NULL`;
    if (from) { params.push(from); w += ` AND oe.expense_date >= $${params.length}`; }
    if (to) { params.push(to); w += ` AND oe.expense_date <= $${params.length}`; }
    const { rows } = await query(
      `SELECT oe.expense_date, o.code AS outlet_code, o.name AS outlet, ec.code AS category_code, ec.name AS category,
              ec.category_type, oe.amount, oe.description, oe.reference, oe.source
         FROM operating_expenses oe JOIN outlets o ON o.id = oe.outlet_id
         JOIN expense_categories ec ON ec.id = oe.expense_category_id ${w}
        ORDER BY oe.expense_date, o.name LIMIT ${MAX_ROWS}`, params,
    );
    return {
      title: 'Expenses', orgId, demo: rows.some((r) => r.source === 'demo_seed'),
      columns: [
        { key: 'expense_date', label: 'Date' }, { key: 'outlet_code', label: 'Outlet code' }, { key: 'outlet', label: 'Outlet' },
        { key: 'category_code', label: 'Category code' }, { key: 'category', label: 'Category' }, { key: 'category_type', label: 'Type' },
        { key: 'amount', label: 'Amount', type: 'money' }, { key: 'description', label: 'Description' }, { key: 'reference', label: 'Reference' },
      ],
      rows,
    };
  },

  async inventory(req) {
    const { where, params } = await scopedOutletWhere(req, P.FRANCHISE_READ);
    const orgId = await orgOf(req);
    requireExport(req, orgId);
    const { rows } = await query(
      `SELECT o.code AS outlet_code, o.name AS outlet, p.sku, p.name AS product, p.unit, ib.quantity, p.reorder_level,
              p.unit_cost, CASE WHEN p.unit_cost IS NULL THEN NULL ELSE ROUND(ib.quantity * p.unit_cost, 2) END AS stock_value,
              CASE WHEN ib.quantity <= p.reorder_level THEN 'LOW' ELSE '' END AS status
         FROM inventory_balances ib JOIN outlets o ON o.id = ib.outlet_id JOIN products p ON p.id = ib.product_id
        WHERE ${where} ORDER BY o.name, p.name LIMIT ${MAX_ROWS}`, params,
    );
    return {
      title: 'Inventory balances', orgId,
      columns: [
        { key: 'outlet_code', label: 'Outlet code' }, { key: 'outlet', label: 'Outlet' }, { key: 'sku', label: 'SKU' },
        { key: 'product', label: 'Product' }, { key: 'unit', label: 'Unit' }, { key: 'quantity', label: 'Quantity', type: 'number' },
        { key: 'reorder_level', label: 'Reorder level', type: 'number' }, { key: 'unit_cost', label: 'Unit cost', type: 'money' },
        { key: 'stock_value', label: 'Stock value', type: 'money' }, { key: 'status', label: 'Status' },
      ],
      rows,
    };
  },

  async audit(req) {
    const { orgId, from, to } = req.query;
    requirePermission(req, orgId, P.AUDIT_READ);
    requireExport(req, orgId);
    const params = [orgId];
    let w = 'WHERE org_id = $1';
    if (from && isIsoDate(from)) { params.push(from); w += ` AND created_at >= $${params.length}::date`; }
    if (to && isIsoDate(to)) { params.push(to); w += ` AND created_at < ($${params.length}::date + 1)`; }
    const { rows } = await query(
      `SELECT created_at, actor_email, action, resource_type, resource_id, metadata FROM audit_events ${w}
        ORDER BY created_at DESC LIMIT ${MAX_ROWS}`, params,
    );
    return {
      title: 'Audit trail', orgId,
      columns: [
        { key: 'created_at', label: 'Time' }, { key: 'actor_email', label: 'Actor' }, { key: 'action', label: 'Action' },
        { key: 'resource_type', label: 'Resource' }, { key: 'resource_id', label: 'Resource ID' }, { key: 'metadata', label: 'Details' },
      ],
      rows: rows.map((r) => ({ ...r, created_at: new Date(r.created_at).toISOString(), metadata: r.metadata ? JSON.stringify(r.metadata) : '' })),
    };
  },
};

/** Organisation of an outlet/org-scoped export request. */
async function orgOf(req) {
  if (req.query.outletId) {
    if (!isUuid(req.query.outletId)) throw new AppError('Invalid outlet.', 400);
    const { rows } = await query('SELECT org_id FROM outlets WHERE id = $1', [req.query.outletId]);
    return rows[0]?.org_id;
  }
  return req.query.orgId;
}

router.get('/:dataset', async (req, res, next) => {
  try {
    const build = DATASETS[req.params.dataset];
    if (!build) throw new AppError('Unknown export dataset.', 404);
    const format = ['csv', 'xlsx', 'pdf'].includes(req.query.format) ? req.query.format : 'csv';
    const ds = await build(req);
    const disclaimer = ds.demo || config.demoMode ? DEMO_NOTE : null;
    const out = await render(format, ds.columns, ds.rows, {
      title: ds.title, subtitle: ds.subtitle || `Generated ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC`, disclaimer,
    });
    await audit(req, {
      orgId: ds.orgId || null, action: `export.${req.params.dataset}`, resourceType: 'export', resourceId: req.params.dataset,
      metadata: { format, rows: ds.rows.length, filters: { ...req.query } },
    });
    const name = `${req.params.dataset}-${new Date().toISOString().slice(0, 10)}.${out.ext}`;
    res.setHeader('Content-Type', out.type);
    res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
    res.setHeader('Cache-Control', 'no-store');
    return res.send(out.body);
  } catch (err) { next(err); }
});

export default router;
