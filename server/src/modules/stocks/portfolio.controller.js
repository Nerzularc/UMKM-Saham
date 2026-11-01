import * as portfolioService from './portfolio.service.js';
import { query } from '../../config/database.js';
import { successResponse, createdResponse } from '../../utils/response.js';
import { audit } from '../audit/audit.service.js';
import { isIsoDate } from '../../utils/dates.js';
import { AppError } from '../../utils/errors.js';

export async function list(req, res, next) {
  try {
    return successResponse(res, await portfolioService.listPortfolios(req, req.query.orgId || null));
  } catch (err) { next(err); }
}

export async function create(req, res, next) {
  try {
    const portfolio = await portfolioService.createPortfolio(req.body, req);
    await audit(req, { orgId: portfolio.org_id, action: 'portfolio.create', resourceType: 'portfolio', resourceId: portfolio.id, newValues: portfolio });
    return createdResponse(res, portfolio);
  } catch (err) { next(err); }
}

export async function getOne(req, res, next) {
  try {
    return successResponse(res, await portfolioService.getPortfolio(req.params.id, req));
  } catch (err) { next(err); }
}

export async function holdings(req, res, next) {
  try {
    return successResponse(res, await portfolioService.getPortfolioHoldings(req.params.id, req));
  } catch (err) { next(err); }
}

export async function performance(req, res, next) {
  try {
    const { from, to } = req.query;
    if ((from && !isIsoDate(from)) || (to && !isIsoDate(to))) throw new AppError('Dates must use YYYY-MM-DD.', 400);
    return successResponse(res, await portfolioService.getPortfolioPerformance(req.params.id, req, { from, to }));
  } catch (err) { next(err); }
}

export async function update(req, res, next) {
  try {
    const before = await portfolioService.getPortfolio(req.params.id, req, { write: true });
    const { name, description, costBasisMethod } = req.body;
    // Base currency is fixed once transactions exist, because stored FX rates refer to it.
    if (req.body.baseCurrency && req.body.baseCurrency !== before.base_currency) {
      const { rows } = await query('SELECT 1 FROM portfolio_transactions WHERE portfolio_id = $1 AND deleted_at IS NULL LIMIT 1', [before.id]);
      if (rows.length) throw new AppError('Base currency cannot change after transactions are recorded.', 422);
    }
    const { rows } = await query(
      `UPDATE portfolios SET name = COALESCE($2, name), description = COALESCE($3, description),
         base_currency = COALESCE($4, base_currency), cost_basis_method = COALESCE($5, cost_basis_method)
       WHERE id = $1 RETURNING *`,
      [before.id, name, description, req.body.baseCurrency?.toUpperCase(), costBasisMethod?.toUpperCase()],
    );
    await audit(req, { orgId: before.org_id, action: 'portfolio.update', resourceType: 'portfolio', resourceId: before.id, oldValues: before, newValues: rows[0] });
    return successResponse(res, rows[0]);
  } catch (err) { next(err); }
}

export async function remove(req, res, next) {
  try {
    const before = await portfolioService.getPortfolio(req.params.id, req, { write: true });
    await query('UPDATE portfolios SET deleted_at = NOW() WHERE id = $1', [before.id]);
    await audit(req, { orgId: before.org_id, action: 'portfolio.delete', resourceType: 'portfolio', resourceId: before.id, oldValues: before });
    return res.status(204).send();
  } catch (err) { next(err); }
}
