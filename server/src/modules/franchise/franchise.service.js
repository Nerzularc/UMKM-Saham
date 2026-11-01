/**
 * Franchise reporting service.
 *
 * Every aggregate here is built from the same outlet filter and the same
 * inclusive date boundaries, so dashboards, tables, charts and exports agree.
 * All arithmetic is done in PostgreSQL NUMERIC and Decimal.js.
 */
import Decimal from 'decimal.js';
import { query } from '../../config/database.js';
import {
  calcFranchisePnL, calcTargetAchievement, calcGrowth, calcATV, toFixed,
} from '../../services/financialCalculations.js';
import { scopeSql } from '../../services/permissions.js';
import { previousPeriod, isIsoDate, addDays, daysBetween } from '../../utils/dates.js';

/**
 * Build the outlet filter shared by every franchise query.
 * Produces SQL on alias `o` and pushes parameters (orgId is always $1).
 */
export function outletFilter({ orgId, scope, outletId, brandId, regionId, status }, params) {
  params.push(orgId);
  let sql = `o.org_id = $${params.length} AND o.deleted_at IS NULL`;
  sql += scopeSql(scope, params, 'o.id');
  if (outletId) { params.push(outletId); sql += ` AND o.id = $${params.length}`; }
  if (brandId)  { params.push(brandId);  sql += ` AND o.brand_id = $${params.length}`; }
  if (regionId) { params.push(regionId); sql += ` AND o.region_id = $${params.length}`; }
  if (status)   { params.push(status);   sql += ` AND o.status = $${params.length}`; }
  return sql;
}

/** Consolidated P&L for every outlet matching the filter within [from, to]. */
export async function aggregatePnl(filter, period) {
  const params = [];
  const where = outletFilter(filter, params);
  params.push(period.from, period.to);
  const pFrom = `$${params.length - 1}`;
  const pTo = `$${params.length}`;

  const [{ rows: [s] }, { rows: e }] = await Promise.all([
    query(
      `SELECT COALESCE(SUM(sr.gross_sales),0) AS gross_sales,
              COALESCE(SUM(sr.discounts),0)   AS discounts,
              COALESCE(SUM(sr.returns),0)     AS returns,
              COALESCE(SUM(sr.transaction_count),0) AS tx_count,
              COUNT(DISTINCT o.id)            AS outlets_with_sales
         FROM outlets o
         JOIN sales_records sr ON sr.outlet_id = o.id AND sr.deleted_at IS NULL
                              AND sr.sale_date BETWEEN ${pFrom} AND ${pTo}
        WHERE ${where}`,
      params,
    ),
    query(
      `SELECT ec.category_type, COALESCE(SUM(oe.amount),0) AS amount
         FROM outlets o
         JOIN operating_expenses oe ON oe.outlet_id = o.id AND oe.deleted_at IS NULL
                                   AND oe.expense_date BETWEEN ${pFrom} AND ${pTo}
         JOIN expense_categories ec ON ec.id = oe.expense_category_id
        WHERE ${where}
        GROUP BY ec.category_type`,
      params,
    ),
  ]);

  const byType = Object.fromEntries(e.map((r) => [r.category_type, r.amount]));
  const pnl = calcFranchisePnL({
    grossSales: s.gross_sales,
    discounts: s.discounts,
    returns: s.returns,
    cogs: byType.cogs || 0,
    operatingExpenses: byType.operating || 0,
    nonOperatingExpenses: byType.non_operating || 0,
    taxes: byType.tax || 0,
  });
  return {
    ...pnl,
    transactionCount: parseInt(s.tx_count, 10),
    averageTransactionValue: calcATV(pnl.netSales, s.tx_count),
    outletsWithSales: parseInt(s.outlets_with_sales, 10),
  };
}

/** Date range covered by a target row. */
export function targetRange(t) {
  const y = Number(t.period_year);
  const v = t.period_value == null ? null : Number(t.period_value);
  switch (t.period_type) {
    case 'yearly':  return { from: `${y}-01-01`, to: `${y}-12-31` };
    case 'monthly': {
      const from = `${y}-${String(v).padStart(2, '0')}-01`;
      return { from, to: new Date(Date.UTC(y, v, 0)).toISOString().slice(0, 10) };
    }
    case 'weekly': { // ISO week v of year y
      const jan4 = new Date(Date.UTC(y, 0, 4));
      const monday = new Date(jan4);
      monday.setUTCDate(jan4.getUTCDate() - ((jan4.getUTCDay() + 6) % 7) + (v - 1) * 7);
      const from = monday.toISOString().slice(0, 10);
      return { from, to: addDays(from, 6) };
    }
    case 'daily': { // day-of-year v
      const from = addDays(`${y}-01-01`, v - 1);
      return { from, to: from };
    }
    default: return null;
  }
}

/**
 * Pro-rated target amount for a period.
 * A monthly target of 30M over 10 of 30 days counts as 10M; documented in docs/formulas.md.
 */
export function proratedTarget(targets, period) {
  let total = new Decimal(0);
  let any = false;
  for (const t of targets) {
    const r = targetRange(t);
    if (!r) continue;
    const from = r.from > period.from ? r.from : period.from;
    const to = r.to < period.to ? r.to : period.to;
    if (from > to) continue;
    const overlap = daysBetween(from, to) + 1;
    const length = daysBetween(r.from, r.to) + 1;
    total = total.plus(new Decimal(t.target_amount).times(overlap).dividedBy(length));
    any = true;
  }
  return any ? toFixed(total, 2) : null;
}

/**
 * Per-outlet comparison: sales, profit, margin, ATV, target achievement and growth
 * versus the immediately preceding period of equal length.
 */
export async function outletComparison(filter, period, { includeFinancials = true } = {}) {
  const prev = previousPeriod(period);
  const params = [];
  const where = outletFilter(filter, params);
  params.push(period.from, period.to, prev.from, prev.to);
  const n = params.length;
  const [cf, ct, pf, pt] = [`$${n - 3}`, `$${n - 2}`, `$${n - 1}`, `$${n}`];

  const { rows } = await query(
    `SELECT o.id, o.name, o.code, o.status, o.opening_date, o.city,
            b.name AS brand_name, r.name AS region_name,
            COALESCE(s.gross,0) AS gross_sales, COALESCE(s.disc,0) AS discounts,
            COALESCE(s.ret,0) AS returns, COALESCE(s.tx,0) AS tx_count,
            COALESCE(ps.net,0) AS prev_net_sales,
            COALESCE(x.cogs,0) AS cogs, COALESCE(x.opex,0) AS opex,
            COALESCE(x.nonop,0) AS nonop, COALESCE(x.tax,0) AS tax
       FROM outlets o
       LEFT JOIN brands b ON b.id = o.brand_id
       LEFT JOIN regions r ON r.id = o.region_id
       LEFT JOIN LATERAL (
         SELECT SUM(gross_sales) gross, SUM(discounts) disc, SUM(returns) ret, SUM(transaction_count) tx
           FROM sales_records WHERE outlet_id = o.id AND deleted_at IS NULL
            AND sale_date BETWEEN ${cf} AND ${ct}) s ON TRUE
       LEFT JOIN LATERAL (
         SELECT SUM(net_sales) net FROM sales_records WHERE outlet_id = o.id AND deleted_at IS NULL
            AND sale_date BETWEEN ${pf} AND ${pt}) ps ON TRUE
       LEFT JOIN LATERAL (
         SELECT SUM(CASE WHEN ec.category_type='cogs' THEN oe.amount END) cogs,
                SUM(CASE WHEN ec.category_type='operating' THEN oe.amount END) opex,
                SUM(CASE WHEN ec.category_type='non_operating' THEN oe.amount END) nonop,
                SUM(CASE WHEN ec.category_type='tax' THEN oe.amount END) tax
           FROM operating_expenses oe JOIN expense_categories ec ON ec.id = oe.expense_category_id
          WHERE oe.outlet_id = o.id AND oe.deleted_at IS NULL
            AND oe.expense_date BETWEEN ${cf} AND ${ct}) x ON TRUE
      WHERE ${where}
      ORDER BY o.name`,
    params,
  );

  const outletIds = rows.map((r) => r.id);
  const { rows: targets } = outletIds.length
    ? await query(
      `SELECT outlet_id, period_type, period_year, period_value, target_amount
         FROM targets WHERE target_type = 'sales' AND outlet_id = ANY($1::uuid[])
          AND period_year BETWEEN $2 AND $3`,
      [outletIds, Number(period.from.slice(0, 4)), Number(period.to.slice(0, 4))],
    )
    : { rows: [] };

  return rows.map((r) => {
    const pnl = calcFranchisePnL({
      grossSales: r.gross_sales, discounts: r.discounts, returns: r.returns,
      cogs: r.cogs, operatingExpenses: r.opex, nonOperatingExpenses: r.nonop, taxes: r.tax,
    });
    const target = proratedTarget(targets.filter((t) => t.outlet_id === r.id), period);
    const achievement = target ? calcTargetAchievement(pnl.netSales, target) : null;
    const growth = calcGrowth(pnl.netSales, r.prev_net_sales);
    // Opened during or after the period start → not comparable with a full period.
    const partialPeriod = !!(r.opening_date && r.opening_date > period.from);
    const underperforming = (achievement !== null && achievement < 80) || pnl.netProfit < 0;

    const base = {
      id: r.id, name: r.name, code: r.code, status: r.status, city: r.city,
      brandName: r.brand_name, regionName: r.region_name, openingDate: r.opening_date,
      netSales: pnl.netSales, grossSales: pnl.grossSales,
      transactionCount: parseInt(r.tx_count, 10),
      averageTransactionValue: calcATV(pnl.netSales, r.tx_count),
      previousNetSales: toFixed(r.prev_net_sales, 2),
      salesGrowthPct: growth,
      target, achievementPct: achievement,
      partialPeriod, underperforming,
    };
    if (!includeFinancials) return base;
    return {
      ...base,
      cogs: pnl.cogs, operatingExpenses: pnl.operatingExpenses,
      grossProfit: pnl.grossProfit, grossMarginPct: pnl.grossMarginPct,
      operatingProfit: pnl.operatingProfit, netProfit: pnl.netProfit, netMarginPct: pnl.netMarginPct,
    };
  });
}

/** Monthly P&L series. */
export async function monthlyPnl(filter, period) {
  const params = [];
  const where = outletFilter(filter, params);
  params.push(period.from, period.to);
  const pFrom = `$${params.length - 1}`;
  const pTo = `$${params.length}`;

  const [{ rows: sales }, { rows: exps }] = await Promise.all([
    query(
      `SELECT to_char(sr.sale_date, 'YYYY-MM') AS month,
              SUM(sr.gross_sales) gross, SUM(sr.discounts) disc, SUM(sr.returns) ret,
              SUM(sr.transaction_count) tx
         FROM sales_records sr JOIN outlets o ON o.id = sr.outlet_id
        WHERE ${where} AND sr.deleted_at IS NULL AND sr.sale_date BETWEEN ${pFrom} AND ${pTo}
        GROUP BY 1`,
      params,
    ),
    query(
      `SELECT to_char(oe.expense_date, 'YYYY-MM') AS month, ec.category_type, SUM(oe.amount) amount
         FROM operating_expenses oe
         JOIN outlets o ON o.id = oe.outlet_id
         JOIN expense_categories ec ON ec.id = oe.expense_category_id
        WHERE ${where} AND oe.deleted_at IS NULL AND oe.expense_date BETWEEN ${pFrom} AND ${pTo}
        GROUP BY 1, 2`,
      params,
    ),
  ]);

  const months = new Map();
  const ensure = (m) => {
    if (!months.has(m)) months.set(m, { month: m, gross: 0, disc: 0, ret: 0, tx: 0 });
    return months.get(m);
  };
  for (const s of sales) Object.assign(ensure(s.month), s);
  for (const e of exps) ensure(e.month)[e.category_type] = e.amount;

  return [...months.values()].sort((a, b) => a.month.localeCompare(b.month)).map((m) => {
    const pnl = calcFranchisePnL({
      grossSales: m.gross, discounts: m.disc, returns: m.ret,
      cogs: m.cogs || 0, operatingExpenses: m.operating || 0,
      nonOperatingExpenses: m.non_operating || 0, taxes: m.tax || 0,
    });
    return { month: m.month, transactionCount: parseInt(m.tx || 0, 10), ...pnl, averageTransactionValue: calcATV(pnl.netSales, m.tx || 0) };
  });
}

/** Daily net sales series (for trend charts). */
export async function dailySales(filter, period) {
  const params = [];
  const where = outletFilter(filter, params);
  params.push(period.from, period.to);
  const { rows } = await query(
    `SELECT sr.sale_date AS date, SUM(sr.net_sales) AS net_sales, SUM(sr.transaction_count) AS tx
       FROM sales_records sr JOIN outlets o ON o.id = sr.outlet_id
      WHERE ${where} AND sr.deleted_at IS NULL
        AND sr.sale_date BETWEEN $${params.length - 1} AND $${params.length}
      GROUP BY 1 ORDER BY 1`,
    params,
  );
  return rows.map((r) => ({ date: r.date, netSales: toFixed(r.net_sales, 2), transactionCount: parseInt(r.tx, 10) }));
}

/** Expense totals by category and month. */
export async function expenseTrend(filter, period) {
  const params = [];
  const where = outletFilter(filter, params);
  params.push(period.from, period.to);
  const { rows } = await query(
    `SELECT to_char(oe.expense_date, 'YYYY-MM') AS month, ec.name AS category, ec.category_type,
            SUM(oe.amount) AS amount
       FROM operating_expenses oe
       JOIN outlets o ON o.id = oe.outlet_id
       JOIN expense_categories ec ON ec.id = oe.expense_category_id
      WHERE ${where} AND oe.deleted_at IS NULL
        AND oe.expense_date BETWEEN $${params.length - 1} AND $${params.length}
      GROUP BY 1, 2, 3 ORDER BY 1, 2`,
    params,
  );
  return rows.map((r) => ({ month: r.month, category: r.category, categoryType: r.category_type, amount: toFixed(r.amount, 2) }));
}

/** Products at or below their reorder level, per outlet in scope. */
export async function lowStock(filter) {
  const params = [];
  const where = outletFilter(filter, params);
  const { rows } = await query(
    `SELECT o.id AS outlet_id, o.name AS outlet_name, p.id AS product_id, p.sku, p.name AS product_name,
            ib.quantity, p.reorder_level, p.unit
       FROM inventory_balances ib
       JOIN outlets o ON o.id = ib.outlet_id
       JOIN products p ON p.id = ib.product_id AND p.deleted_at IS NULL
      WHERE ${where} AND ib.quantity <= p.reorder_level
      ORDER BY (ib.quantity - p.reorder_level) ASC, o.name
      LIMIT 200`,
    params,
  );
  return rows;
}

export function validateFilterDates(from, to) {
  if (from && !isIsoDate(from)) return false;
  if (to && !isIsoDate(to)) return false;
  return true;
}
