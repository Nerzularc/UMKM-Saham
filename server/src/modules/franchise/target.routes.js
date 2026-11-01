import express from 'express';
import { body } from 'express-validator';
import { validate } from '../../middleware/validate.js';
import { requireAuth } from '../../middleware/auth.js';
import { query } from '../../config/database.js';
import { successResponse } from '../../utils/response.js';
import { AppError, NotFoundError } from '../../utils/errors.js';
import { audit } from '../audit/audit.service.js';
import { PERMISSIONS as P, franchiseContext, assertBelongsToOrg, scopeSql, isUuid } from '../../services/permissions.js';
import { targetRange } from './franchise.service.js';
import { calcTargetAchievement } from '../../services/financialCalculations.js';
import { randomUUID as uuidv4 } from 'crypto';

const router = express.Router();
router.use(requireAuth);

const PERIOD_LIMITS = { daily: 366, weekly: 53, monthly: 12 };

// GET /api/v1/targets?orgId=&year=&month=&outletId=
// Returns targets with actual net sales over the exact target period and achievement %.
router.get('/', async (req, res, next) => {
  try {
    const { orgId, outletId, year, periodType } = req.query;
    const { scope } = await franchiseContext(req, orgId, P.FRANCHISE_READ);
    await assertBelongsToOrg('outlets', outletId, orgId, 'outlet');
    const params = [orgId];
    let where = 'WHERE t.org_id = $1';
    // Scoped users see outlet targets for their outlets only.
    if (!scope.all) where += scopeSql(scope, params, 't.outlet_id');
    if (outletId) { params.push(outletId); where += ` AND t.outlet_id = $${params.length}`; }
    if (year && /^\d{4}$/.test(year)) { params.push(Number(year)); where += ` AND t.period_year = $${params.length}`; }
    if (req.query.month && /^\d{1,2}$/.test(req.query.month)) { params.push(Number(req.query.month)); where += ` AND t.period_type = 'monthly' AND t.period_value = $${params.length}`; }
    if (['daily', 'weekly', 'monthly', 'yearly'].includes(periodType)) { params.push(periodType); where += ` AND t.period_type = $${params.length}`; }

    const { rows: targets } = await query(
      `SELECT t.*, o.name AS outlet_name, b.name AS brand_name, r.name AS region_name
         FROM targets t
         LEFT JOIN outlets o ON o.id = t.outlet_id
         LEFT JOIN brands b ON b.id = t.brand_id
         LEFT JOIN regions r ON r.id = t.region_id
        ${where} ORDER BY t.period_year DESC, t.period_value DESC NULLS LAST, o.name LIMIT 500`,
      params,
    );

    // Compute actuals per target over its own date range and scope.
    const result = [];
    for (const t of targets) {
      const range = targetRange(t);
      const p = [orgId, range.from, range.to];
      let w = 'o.org_id = $1 AND o.deleted_at IS NULL';
      if (t.outlet_id) { p.push(t.outlet_id); w += ` AND o.id = $${p.length}`; }
      if (t.brand_id)  { p.push(t.brand_id);  w += ` AND o.brand_id = $${p.length}`; }
      if (t.region_id) { p.push(t.region_id); w += ` AND o.region_id = $${p.length}`; }
      if (!scope.all) w += scopeSql(scope, p, 'o.id');
      const metric = t.target_type === 'transactions' ? 'SUM(sr.transaction_count)' : 'SUM(sr.net_sales)';
      const { rows: a } = await query(
        `SELECT COALESCE(${metric},0) AS actual FROM sales_records sr JOIN outlets o ON o.id = sr.outlet_id
          WHERE ${w} AND sr.deleted_at IS NULL AND sr.sale_date BETWEEN $2 AND $3`, p,
      );
      result.push({
        ...t, period_from: range.from, period_to: range.to,
        actual: Number(a[0].actual),
        achievement_pct: t.target_type === 'profit' ? null : calcTargetAchievement(a[0].actual, t.target_amount),
      });
    }
    return successResponse(res, result);
  } catch (err) { next(err); }
});

// POST /api/v1/targets — create or replace a target for a scope/period (upsert)
router.post('/',
  [
    body('orgId').isUUID(),
    body('targetType').optional().isIn(['sales', 'transactions']),
    body('periodType').isIn(['daily', 'weekly', 'monthly', 'yearly']),
    body('periodYear').isInt({ min: 2000, max: 2100 }),
    body('periodValue').optional({ values: 'null' }).isInt({ min: 1, max: 366 }),
    body('targetAmount').isFloat({ gt: 0, max: 1e15 }),
    body('outletId').optional({ values: 'falsy' }).isUUID(),
    body('brandId').optional({ values: 'falsy' }).isUUID(),
    body('regionId').optional({ values: 'falsy' }).isUUID(),
  ],
  validate,
  async (req, res, next) => {
    try {
      const { orgId, brandId, regionId, outletId, targetType = 'sales', periodType, periodYear, periodValue, targetAmount } = req.body;
      const { scope } = await franchiseContext(req, orgId, P.TARGETS_MANAGE);
      await assertBelongsToOrg('outlets', outletId, orgId, 'outlet');
      await assertBelongsToOrg('brands', brandId, orgId, 'brand');
      await assertBelongsToOrg('regions', regionId, orgId, 'region');
      if (!scope.all && (!outletId || !scope.outletIds.includes(outletId))) {
        throw new AppError('Managers can only set targets for their assigned outlets.', 403);
      }
      if (periodType !== 'yearly' && (!periodValue || periodValue > PERIOD_LIMITS[periodType])) {
        throw new AppError(`periodValue is required for ${periodType} targets.`, 422);
      }
      const value = periodType === 'yearly' ? null : periodValue;
      const { rows: existing } = await query(
        `SELECT * FROM targets WHERE org_id = $1 AND outlet_id IS NOT DISTINCT FROM $2 AND brand_id IS NOT DISTINCT FROM $3
           AND region_id IS NOT DISTINCT FROM $4 AND target_type = $5 AND period_type = $6 AND period_year = $7
           AND period_value IS NOT DISTINCT FROM $8`,
        [orgId, outletId || null, brandId || null, regionId || null, targetType, periodType, periodYear, value],
      );
      let row;
      if (existing.length) {
        ({ rows: [row] } = await query('UPDATE targets SET target_amount = $2 WHERE id = $1 RETURNING *', [existing[0].id, targetAmount]));
      } else {
        ({ rows: [row] } = await query(
          `INSERT INTO targets (id, org_id, brand_id, region_id, outlet_id, target_type, period_type, period_year, period_value, target_amount, currency, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'IDR',$11) RETURNING *`,
          [uuidv4(), orgId, brandId || null, regionId || null, outletId || null, targetType, periodType, periodYear, value, targetAmount, req.user.id],
        ));
      }
      await audit(req, { orgId, action: existing.length ? 'target.update' : 'target.create', resourceType: 'target', resourceId: row.id, oldValues: existing[0] || null, newValues: row });
      return res.status(existing.length ? 200 : 201).json({ success: true, data: row });
    } catch (err) { next(err); }
  },
);

// DELETE /api/v1/targets/:id
router.delete('/:id', async (req, res, next) => {
  try {
    if (!isUuid(req.params.id)) throw new NotFoundError('Target');
    const { rows } = await query('SELECT * FROM targets WHERE id = $1', [req.params.id]);
    const t = rows[0];
    if (!t || !req.memberships.some((m) => m.org_id === t.org_id)) throw new NotFoundError('Target');
    const { scope } = await franchiseContext(req, t.org_id, P.TARGETS_MANAGE);
    if (!scope.all && !scope.outletIds.includes(t.outlet_id)) throw new AppError('Not allowed for this target.', 403);
    await query('DELETE FROM targets WHERE id = $1', [t.id]);
    await audit(req, { orgId: t.org_id, action: 'target.delete', resourceType: 'target', resourceId: t.id, oldValues: t });
    return res.status(204).send();
  } catch (err) { next(err); }
});

export default router;
