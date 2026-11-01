import express from 'express';
import { body } from 'express-validator';
import { validate } from '../../middleware/validate.js';
import { requireAuth } from '../../middleware/auth.js';
import { query } from '../../config/database.js';
import { successResponse, createdResponse } from '../../utils/response.js';
import { NotFoundError } from '../../utils/errors.js';
import { audit } from '../audit/audit.service.js';
import { PERMISSIONS as P, franchiseContext, assertBelongsToOrg, isUuid } from '../../services/permissions.js';
import { randomUUID as uuidv4 } from 'crypto';

const router = express.Router();
router.use(requireAuth);

// GET /api/v1/regions?orgId=&brandId=
router.get('/', async (req, res, next) => {
  try {
    const { orgId, brandId } = req.query;
    const { scope } = await franchiseContext(req, orgId, P.FRANCHISE_READ);
    await assertBelongsToOrg('brands', brandId, orgId, 'brand');
    const params = [orgId];
    let where = 'WHERE r.org_id = $1 AND r.deleted_at IS NULL';
    if (brandId) { params.push(brandId); where += ` AND r.brand_id = $${params.length}`; }
    let outletJoin = 'o.region_id = r.id AND o.deleted_at IS NULL';
    if (!scope.all) { params.push(scope.outletIds); outletJoin += ` AND o.id = ANY($${params.length}::uuid[])`; }
    const { rows } = await query(
      `SELECT r.*, b.name AS brand_name, COUNT(o.id)::int AS outlet_count
         FROM regions r
         LEFT JOIN brands b ON b.id = r.brand_id
         LEFT JOIN outlets o ON ${outletJoin}
        ${where} GROUP BY r.id, b.name ORDER BY r.name`,
      params,
    );
    return successResponse(res, rows);
  } catch (err) { next(err); }
});

// POST /api/v1/regions
router.post('/',
  [body('orgId').isUUID(), body('name').trim().isLength({ min: 1, max: 255 }), body('brandId').optional({ values: 'falsy' }).isUUID()],
  validate,
  async (req, res, next) => {
    try {
      const { orgId, brandId, name, code, description } = req.body;
      await franchiseContext(req, orgId, P.STRUCTURE_MANAGE);
      await assertBelongsToOrg('brands', brandId, orgId, 'brand');
      const { rows } = await query(
        `INSERT INTO regions (id, org_id, brand_id, name, code, description)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [uuidv4(), orgId, brandId || null, name, code || null, description || null],
      );
      await audit(req, { orgId, action: 'region.create', resourceType: 'region', resourceId: rows[0].id, newValues: rows[0] });
      return createdResponse(res, rows[0]);
    } catch (err) { next(err); }
  },
);

// PUT /api/v1/regions/:id
router.put('/:id', [body('name').optional().trim().isLength({ min: 1, max: 255 })], validate, async (req, res, next) => {
  try {
    if (!isUuid(req.params.id)) throw new NotFoundError('Region');
    const { rows: found } = await query('SELECT * FROM regions WHERE id = $1 AND deleted_at IS NULL', [req.params.id]);
    const region = found[0];
    if (!region || !req.memberships.some((m) => m.org_id === region.org_id)) throw new NotFoundError('Region');
    await franchiseContext(req, region.org_id, P.STRUCTURE_MANAGE);
    const { name, code, description } = req.body;
    const { rows } = await query(
      `UPDATE regions SET name = COALESCE($2,name), code = COALESCE($3,code), description = COALESCE($4,description)
       WHERE id = $1 RETURNING *`,
      [region.id, name, code, description],
    );
    await audit(req, { orgId: region.org_id, action: 'region.update', resourceType: 'region', resourceId: region.id, oldValues: region, newValues: rows[0] });
    return successResponse(res, rows[0]);
  } catch (err) { next(err); }
});

export default router;
