import express from 'express';
import { body } from 'express-validator';
import { validate } from '../../middleware/validate.js';
import { requireAuth } from '../../middleware/auth.js';
import { query } from '../../config/database.js';
import { successResponse, createdResponse } from '../../utils/response.js';
import { AppError } from '../../utils/errors.js';
import { audit } from '../audit/audit.service.js';
import {
  PERMISSIONS as P, franchiseContext, assertOutletAccess, assertBelongsToOrg, scopeSql, roleHas, isUuid,
} from '../../services/permissions.js';
import { resolvePeriod } from '../../utils/dates.js';
import { aggregatePnl } from './franchise.service.js';
import { randomUUID as uuidv4 } from 'crypto';

const router = express.Router();
router.use(requireAuth);

const STATUSES = ['active', 'inactive', 'closed', 'renovating'];

// GET /api/v1/outlets?orgId=&brandId=&regionId=&status=&q=
router.get('/', async (req, res, next) => {
  try {
    const { orgId, brandId, regionId, status, q } = req.query;
    const { scope } = await franchiseContext(req, orgId, P.FRANCHISE_READ);
    await assertBelongsToOrg('brands', brandId, orgId, 'brand');
    await assertBelongsToOrg('regions', regionId, orgId, 'region');
    const params = [orgId];
    let where = 'WHERE o.org_id = $1 AND o.deleted_at IS NULL';
    where += scopeSql(scope, params, 'o.id');
    if (brandId)  { params.push(brandId);  where += ` AND o.brand_id = $${params.length}`; }
    if (regionId) { params.push(regionId); where += ` AND o.region_id = $${params.length}`; }
    if (status && STATUSES.includes(status)) { params.push(status); where += ` AND o.status = $${params.length}`; }
    if (q) { params.push(`%${String(q).slice(0, 100)}%`); where += ` AND (o.name ILIKE $${params.length} OR o.code ILIKE $${params.length} OR o.city ILIKE $${params.length})`; }
    const { rows } = await query(
      `SELECT o.*, b.name AS brand_name, r.name AS region_name,
              (SELECT COALESCE(json_agg(json_build_object('userId', u.id, 'fullName', u.full_name, 'role', oa.role)), '[]')
                 FROM outlet_assignments oa JOIN users u ON u.id = oa.user_id
                WHERE oa.outlet_id = o.id AND oa.is_active = TRUE AND oa.role = 'manager') AS managers
         FROM outlets o
         LEFT JOIN brands b ON b.id = o.brand_id
         LEFT JOIN regions r ON r.id = o.region_id
        ${where} ORDER BY o.name`,
      params,
    );
    return successResponse(res, rows);
  } catch (err) { next(err); }
});

const outletValidators = [
  body('name').optional().trim().isLength({ min: 1, max: 255 }),
  body('code').optional({ values: 'falsy' }).trim().isLength({ max: 50 }),
  body('email').optional({ values: 'falsy' }).isEmail(),
  body('openingDate').optional({ values: 'falsy' }).isISO8601({ strict: true }),
  body('status').optional().isIn(STATUSES),
  body('reportingCurrency').optional().isLength({ min: 3, max: 3 }).isAlpha(),
];

// POST /api/v1/outlets
router.post('/',
  [body('orgId').isUUID(), body('brandId').isUUID(), body('name').trim().isLength({ min: 1, max: 255 }), ...outletValidators],
  validate,
  async (req, res, next) => {
    try {
      const { orgId, brandId, regionId, name, code, address, city, province,
        postalCode, phone, email, openingDate, status = 'active', reportingCurrency = 'IDR' } = req.body;
      await franchiseContext(req, orgId, P.STRUCTURE_MANAGE);
      await assertBelongsToOrg('brands', brandId, orgId, 'brand');
      await assertBelongsToOrg('regions', regionId, orgId, 'region');
      const { rows } = await query(
        `INSERT INTO outlets (id, org_id, brand_id, region_id, name, code, address, city, province,
                              postal_code, phone, email, opening_date, status, reporting_currency)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
        [uuidv4(), orgId, brandId, regionId || null, name, code || null, address || null, city || null,
          province || null, postalCode || null, phone || null, email || null, openingDate || null,
          status, reportingCurrency.toUpperCase()],
      );
      await audit(req, { orgId, action: 'outlet.create', resourceType: 'outlet', resourceId: rows[0].id, newValues: rows[0] });
      return createdResponse(res, rows[0]);
    } catch (err) { next(err); }
  },
);

// GET /api/v1/outlets/:id
router.get('/:id', async (req, res, next) => {
  try {
    const { outlet } = await assertOutletAccess(req, req.params.id, P.FRANCHISE_READ);
    const { rows } = await query(
      `SELECT o.*, b.name AS brand_name, r.name AS region_name FROM outlets o
         LEFT JOIN brands b ON b.id = o.brand_id LEFT JOIN regions r ON r.id = o.region_id
        WHERE o.id = $1`,
      [outlet.id],
    );
    return successResponse(res, rows[0]);
  } catch (err) { next(err); }
});

// PUT /api/v1/outlets/:id
router.put('/:id', [...outletValidators, body('brandId').optional().isUUID(), body('regionId').optional({ values: 'null' }).isUUID()], validate, async (req, res, next) => {
  try {
    const { outlet } = await assertOutletAccess(req, req.params.id, P.STRUCTURE_MANAGE);
    const { rows: before } = await query('SELECT * FROM outlets WHERE id = $1', [outlet.id]);
    const b = req.body;
    if (b.brandId) await assertBelongsToOrg('brands', b.brandId, outlet.org_id, 'brand');
    if (b.regionId) await assertBelongsToOrg('regions', b.regionId, outlet.org_id, 'region');
    const { rows } = await query(
      `UPDATE outlets SET
         name = COALESCE($2,name), code = COALESCE($3,code), address = COALESCE($4,address),
         city = COALESCE($5,city), province = COALESCE($6,province), postal_code = COALESCE($7,postal_code),
         phone = COALESCE($8,phone), email = COALESCE($9,email), opening_date = COALESCE($10,opening_date),
         status = COALESCE($11,status), brand_id = COALESCE($12,brand_id), region_id = COALESCE($13,region_id),
         is_active = CASE WHEN $11::text IS NULL THEN is_active ELSE $11 = 'active' END
       WHERE id = $1 RETURNING *`,
      [outlet.id, b.name, b.code, b.address, b.city, b.province, b.postalCode, b.phone, b.email,
        b.openingDate, b.status, b.brandId, b.regionId],
    );
    await audit(req, { orgId: outlet.org_id, action: 'outlet.update', resourceType: 'outlet', resourceId: outlet.id, oldValues: before[0], newValues: rows[0] });
    return successResponse(res, rows[0]);
  } catch (err) { next(err); }
});

// GET /api/v1/outlets/:id/summary?from=&to=
router.get('/:id/summary', async (req, res, next) => {
  try {
    const { outlet, membership, scope } = await assertOutletAccess(req, req.params.id, P.FRANCHISE_READ);
    const period = resolvePeriod(req.query, { timezone: membership.default_timezone });
    const pnl = await aggregatePnl({ orgId: outlet.org_id, scope, outletId: outlet.id }, period);
    const canSeeFinancials = roleHas(membership.role_name, P.FINANCIALS_READ);
    return successResponse(res, {
      outlet,
      period,
      pnl: canSeeFinancials ? pnl : { netSales: pnl.netSales, grossSales: pnl.grossSales, transactionCount: pnl.transactionCount, averageTransactionValue: pnl.averageTransactionValue },
    });
  } catch (err) { next(err); }
});

// GET /api/v1/outlets/:id/assignments
router.get('/:id/assignments', async (req, res, next) => {
  try {
    const { outlet } = await assertOutletAccess(req, req.params.id, P.MEMBERS_READ);
    const { rows } = await query(
      `SELECT oa.id, oa.user_id, u.full_name, u.email, oa.role, oa.is_active, oa.assigned_at
         FROM outlet_assignments oa JOIN users u ON u.id = oa.user_id
        WHERE oa.outlet_id = $1 ORDER BY oa.role, u.full_name`,
      [outlet.id],
    );
    return successResponse(res, rows);
  } catch (err) { next(err); }
});

// POST /api/v1/outlets/:id/assignments  { userId, role: manager|staff }
router.post('/:id/assignments',
  [body('userId').isUUID(), body('role').isIn(['manager', 'staff']), body('isActive').optional().isBoolean()],
  validate,
  async (req, res, next) => {
    try {
      const { outlet } = await assertOutletAccess(req, req.params.id, P.MEMBERS_MANAGE);
      const { userId, role, isActive = true } = req.body;
      if (!isUuid(userId)) throw new AppError('Invalid user.', 400);
      // The assignee must already be an active member of the same organisation.
      const { rows: mem } = await query(
        'SELECT 1 FROM org_memberships WHERE org_id = $1 AND user_id = $2 AND is_active = TRUE',
        [outlet.org_id, userId],
      );
      if (!mem.length) throw new AppError('User is not an active member of this organisation.', 422);
      const { rows } = await query(
        `INSERT INTO outlet_assignments (id, outlet_id, user_id, role, is_active)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (outlet_id, user_id) DO UPDATE SET role = EXCLUDED.role, is_active = EXCLUDED.is_active
         RETURNING *`,
        [uuidv4(), outlet.id, userId, role, isActive],
      );
      await audit(req, { orgId: outlet.org_id, action: 'outlet.assignment', resourceType: 'outlet_assignment', resourceId: rows[0].id, newValues: rows[0] });
      return successResponse(res, rows[0]);
    } catch (err) { next(err); }
  },
);

export default router;
