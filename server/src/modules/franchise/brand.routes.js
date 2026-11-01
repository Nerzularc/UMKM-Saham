import express from 'express';
import { body } from 'express-validator';
import { validate } from '../../middleware/validate.js';
import { requireAuth } from '../../middleware/auth.js';
import { query } from '../../config/database.js';
import { successResponse, createdResponse } from '../../utils/response.js';
import { NotFoundError } from '../../utils/errors.js';
import { audit } from '../audit/audit.service.js';
import { PERMISSIONS as P, franchiseContext, isUuid } from '../../services/permissions.js';
import { randomUUID as uuidv4 } from 'crypto';

const router = express.Router();
router.use(requireAuth);

async function loadBrand(req, id, permission) {
  if (!isUuid(id)) throw new NotFoundError('Brand');
  const { rows } = await query('SELECT * FROM brands WHERE id = $1 AND deleted_at IS NULL', [id]);
  if (!rows.length || !req.memberships.some((m) => m.org_id === rows[0].org_id)) throw new NotFoundError('Brand');
  await franchiseContext(req, rows[0].org_id, permission);
  return rows[0];
}

// GET /api/v1/brands?orgId=
router.get('/', async (req, res, next) => {
  try {
    const { orgId } = req.query;
    const { scope } = await franchiseContext(req, orgId, P.FRANCHISE_READ);
    const params = [orgId];
    let outletJoin = 'o.brand_id = b.id AND o.deleted_at IS NULL';
    if (!scope.all) { params.push(scope.outletIds); outletJoin += ` AND o.id = ANY($2::uuid[])`; }
    const { rows } = await query(
      `SELECT b.*, COUNT(o.id)::int AS outlet_count
         FROM brands b LEFT JOIN outlets o ON ${outletJoin}
        WHERE b.org_id = $1 AND b.deleted_at IS NULL
        GROUP BY b.id ORDER BY b.name`,
      params,
    );
    return successResponse(res, rows);
  } catch (err) { next(err); }
});

// POST /api/v1/brands
router.post('/',
  [body('orgId').isUUID(), body('name').trim().isLength({ min: 1, max: 255 }), body('code').optional({ values: 'falsy' }).trim().isLength({ max: 50 })],
  validate,
  async (req, res, next) => {
    try {
      const { orgId, name, code, description } = req.body;
      await franchiseContext(req, orgId, P.STRUCTURE_MANAGE);
      const { rows } = await query(
        `INSERT INTO brands (id, org_id, name, code, description) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
        [uuidv4(), orgId, name, code || null, description || null],
      );
      await audit(req, { orgId, action: 'brand.create', resourceType: 'brand', resourceId: rows[0].id, newValues: rows[0] });
      return createdResponse(res, rows[0]);
    } catch (err) { next(err); }
  },
);

// PUT /api/v1/brands/:id
router.put('/:id',
  [body('name').optional().trim().isLength({ min: 1, max: 255 }), body('isActive').optional().isBoolean()],
  validate,
  async (req, res, next) => {
    try {
      const brand = await loadBrand(req, req.params.id, P.STRUCTURE_MANAGE);
      const { name, code, description, isActive } = req.body;
      const { rows } = await query(
        `UPDATE brands SET name = COALESCE($2, name), code = COALESCE($3, code),
           description = COALESCE($4, description), is_active = COALESCE($5, is_active)
         WHERE id = $1 RETURNING *`,
        [brand.id, name, code, description, isActive],
      );
      await audit(req, { orgId: brand.org_id, action: 'brand.update', resourceType: 'brand', resourceId: brand.id, oldValues: brand, newValues: rows[0] });
      return successResponse(res, rows[0]);
    } catch (err) { next(err); }
  },
);

export default router;
