import express from 'express';
import { requireAuth } from '../../middleware/auth.js';
import { successResponse } from '../../utils/response.js';
import { PERMISSIONS as P } from '../../services/permissions.js';
import { readFranchiseFilter } from '../franchise/franchise.routes.js';
import { monthlyPnl, aggregatePnl, outletComparison, expenseTrend } from '../franchise/franchise.service.js';
import { listPortfolios, getPortfolioHoldings } from '../stocks/portfolio.service.js';

const router = express.Router();
router.use(requireAuth);

// GET /api/v1/reports/franchise/pnl?orgId=&from=&to=&outletId=&brandId=&regionId=
// Monthly P&L rows (array, kept for compatibility) — totals in meta.
router.get('/franchise/pnl', async (req, res, next) => {
  try {
    const { filter, period } = await readFranchiseFilter(req, P.FINANCIALS_READ, { defaultFrom: 'year' });
    const [months, total, expenses] = await Promise.all([
      monthlyPnl(filter, period), aggregatePnl(filter, period), expenseTrend(filter, period),
    ]);
    return successResponse(res, months, { meta: { period, total, expenses } });
  } catch (err) { next(err); }
});

// GET /api/v1/reports/franchise/comparison
router.get('/franchise/comparison', async (req, res, next) => {
  try {
    const { filter, period, canSeeFinancials } = await readFranchiseFilter(req);
    return successResponse(res, await outletComparison(filter, period, { includeFinancials: canSeeFinancials }), { meta: { period } });
  } catch (err) { next(err); }
});

// GET /api/v1/reports/stocks/overview — summary of every personal portfolio
// (portfolios in different base currencies are reported side by side, never summed).
router.get('/stocks/overview', async (req, res, next) => {
  try {
    const portfolios = await listPortfolios(req, req.query.orgId || null);
    const out = [];
    for (const p of portfolios) {
      const { summary } = await getPortfolioHoldings(p.id, req);
      out.push({ id: p.id, name: p.name, portfolioType: p.portfolio_type, ...summary });
    }
    const byCurrency = {};
    for (const s of out.filter((x) => x.portfolioType !== 'simulation')) {
      const c = (byCurrency[s.baseCurrency] ||= { baseCurrency: s.baseCurrency, totalValue: 0, totalReturn: 0, portfolios: 0 });
      c.totalValue += Number(s.totalValue); c.totalReturn += Number(s.totalReturn); c.portfolios++;
    }
    return successResponse(res, { portfolios: out, totalsByCurrency: Object.values(byCurrency) });
  } catch (err) { next(err); }
});

export default router;
