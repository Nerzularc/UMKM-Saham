import express from 'express';
import { requireAuth } from '../../middleware/auth.js';
import { successResponse } from '../../utils/response.js';
import { resolvePeriod, previousPeriod } from '../../utils/dates.js';
import {
  PERMISSIONS as P, franchiseContext, assertBelongsToOrg, roleHas,
} from '../../services/permissions.js';
import {
  aggregatePnl, outletComparison, dailySales, monthlyPnl, expenseTrend, lowStock,
} from './franchise.service.js';
import { calcGrowth } from '../../services/financialCalculations.js';
import { ForbiddenError } from '../../utils/errors.js';

const router = express.Router();
router.use(requireAuth);

const STATUSES = new Set(['active', 'inactive', 'closed', 'renovating']);

/**
 * Parse and authorise the common franchise filter (orgId, brand, region, outlet, status, period).
 * Exported for reuse by reports and exports.
 */
export async function readFranchiseFilter(req, permission = P.FRANCHISE_READ, { defaultFrom = 'month' } = {}) {
  const { orgId, outletId, brandId, regionId, status, from, to } = req.query;
  const { membership, scope } = await franchiseContext(req, orgId, permission);
  await Promise.all([
    assertBelongsToOrg('outlets', outletId, orgId, 'outlet'),
    assertBelongsToOrg('brands', brandId, orgId, 'brand'),
    assertBelongsToOrg('regions', regionId, orgId, 'region'),
  ]);
  if (outletId && !scope.all && !scope.outletIds.includes(outletId)) {
    throw new ForbiddenError('You are not assigned to this outlet.');
  }
  const period = resolvePeriod({ from, to }, { timezone: membership.default_timezone, defaultFrom });
  return {
    membership,
    period,
    filter: {
      orgId, scope,
      outletId: outletId || null, brandId: brandId || null, regionId: regionId || null,
      status: STATUSES.has(status) ? status : null,
    },
    canSeeFinancials: roleHas(membership.role_name, P.FINANCIALS_READ),
  };
}

// GET /api/v1/franchise/dashboard?orgId=&from=&to=&brandId=&regionId=&outletId=
router.get('/dashboard', async (req, res, next) => {
  try {
    const { filter, period, canSeeFinancials, membership } = await readFranchiseFilter(req);
    const prev = previousPeriod(period);

    const [current, previous, outlets, trend, stock] = await Promise.all([
      aggregatePnl(filter, period),
      aggregatePnl(filter, prev),
      outletComparison(filter, period, { includeFinancials: canSeeFinancials }),
      dailySales(filter, period),
      lowStock(filter),
    ]);

    const targetTotal = outlets.reduce((s, o) => s + (o.target || 0), 0);
    const summary = {
      netSales: current.netSales,
      grossSales: current.grossSales,
      transactionCount: current.transactionCount,
      averageTransactionValue: current.averageTransactionValue,
      salesGrowthPct: calcGrowth(current.netSales, previous.netSales),
      target: targetTotal || null,
      achievementPct: targetTotal ? Math.round((current.netSales / targetTotal) * 10000) / 100 : null,
      outletCount: outlets.length,
      underperformingCount: outlets.filter((o) => o.underperforming).length,
      lowStockCount: stock.length,
    };
    if (canSeeFinancials) {
      Object.assign(summary, {
        cogs: current.cogs,
        grossProfit: current.grossProfit,
        grossMarginPct: current.grossMarginPct,
        operatingExpenses: current.operatingExpenses,
        operatingProfit: current.operatingProfit,
        netProfit: current.netProfit,
        netMarginPct: current.netMarginPct,
        profitGrowthPct: calcGrowth(current.netProfit, previous.netProfit),
      });
    }

    return successResponse(res, {
      period,
      previousPeriod: prev,
      role: membership.role_name,
      scope: filter.scope.all ? 'organisation' : 'assigned_outlets',
      canSeeFinancials,
      summary,
      // Backwards-compatible field used by the original dashboard page
      pnl: canSeeFinancials ? current : { netSales: current.netSales, grossSales: current.grossSales },
      outlets,
      dailySales: trend,
      lowStock: stock.slice(0, 20),
    });
  } catch (err) { next(err); }
});

// GET /api/v1/franchise/comparison — outlet comparison table
router.get('/comparison', async (req, res, next) => {
  try {
    const { filter, period, canSeeFinancials } = await readFranchiseFilter(req);
    const outlets = await outletComparison(filter, period, { includeFinancials: canSeeFinancials });
    return successResponse(res, { period, previousPeriod: previousPeriod(period), outlets });
  } catch (err) { next(err); }
});

// GET /api/v1/franchise/trends — monthly P&L + expense trend
router.get('/trends', async (req, res, next) => {
  try {
    const { filter, period, canSeeFinancials } = await readFranchiseFilter(req, P.FRANCHISE_READ, { defaultFrom: 'year' });
    const months = await monthlyPnl(filter, period);
    const data = { period, months: canSeeFinancials ? months : months.map((m) => ({ month: m.month, netSales: m.netSales, transactionCount: m.transactionCount, averageTransactionValue: m.averageTransactionValue })) };
    if (canSeeFinancials) data.expenses = await expenseTrend(filter, period);
    return successResponse(res, data);
  } catch (err) { next(err); }
});

// GET /api/v1/franchise/low-stock
router.get('/low-stock', async (req, res, next) => {
  try {
    const { filter } = await readFranchiseFilter(req);
    return successResponse(res, await lowStock(filter));
  } catch (err) { next(err); }
});

export default router;
