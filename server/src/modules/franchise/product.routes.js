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

// GET /api/v1/products?orgId=&q=
router.get('/', async (req, res, next) => {
  try {
    const { orgId, q, brandId } = req.query;
    await franchiseContext(req, orgId, P.FRANCHISE_READ);
    const params = [orgId];
    let where = 'WHERE p.org_id = $1 AND p.deleted_at IS NULL';
    if (brandId && isUuid(brandId)) { params.push(brandId); where += ` AND p.brand_id = $${params.length}`; }
    if (q) { params.push(`%${String(q).slice(0, 100)}%`); where += ` AND (p.name ILIKE $${params.length} OR p.sku ILIKE $${params.length})`; }
    const { rows } = await query(`SELECT p.*, b.name AS brand_name FROM products p LEFT JOIN brands b ON b.id = p.brand_id ${where} ORDER BY p.name`, params);
    return successResponse(res, rows);
  } catch (err) { next(err); }
});

const productValidators = [
  body('sku').optional({ values: 'falsy' }).trim().isLength({ max: 100 }),
  body('unit').optional().trim().isLength({ min: 1, max: 50 }),
  body('unitCost').optional({ values: 'null' }).isFloat({ min: 0 }),
  body('unitPrice').optional({ values: 'null' }).isFloat({ min: 0 }),
  body('reorderLevel').optional().isInt({ min: 0 }),
];

router.post('/',
  [body('orgId').isUUID(), body('name').trim().isLength({ min: 1, max: 255 }), ...productValidators],
  validate,
  async (req, res, next) => {
    try {
      const { orgId, brandId, sku, name, description, category, unit = 'pcs', unitCost, unitPrice, reorderLevel = 0 } = req.body;
      await franchiseContext(req, orgId, P.STRUCTURE_MANAGE);
      await assertBelongsToOrg('brands', brandId, orgId, 'brand');
      const { rows } = await query(
        `INSERT INTO products (id, org_id, brand_id, sku, name, description, category, unit, unit_cost, unit_price, reorder_level)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
        [uuidv4(), orgId, brandId || null, sku || null, name, description || null, category || null, unit, unitCost ?? null, unitPrice ?? null, reorderLevel],
      );
      await audit(req, { orgId, action: 'product.create', resourceType: 'product', resourceId: rows[0].id, newValues: rows[0] });
      return createdResponse(res, rows[0]);
    } catch (err) { next(err); }
  },
);

router.put('/:id', [body('name').optional().trim().isLength({ min: 1, max: 255 }), ...productValidators], validate, async (req, res, next) => {
  try {
    if (!isUuid(req.params.id)) throw new NotFoundError('Product');
    const { rows: found } = await query('SELECT * FROM products WHERE id = $1 AND deleted_at IS NULL', [req.params.id]);
    const p = found[0];
    if (!p || !req.memberships.some((m) => m.org_id === p.org_id)) throw new NotFoundError('Product');
    await franchiseContext(req, p.org_id, P.STRUCTURE_MANAGE);
    const b = req.body;
    const { rows } = await query(
      `UPDATE products SET name = COALESCE($2,name), sku = COALESCE($3,sku), unit = COALESCE($4,unit),
         unit_cost = COALESCE($5,unit_cost), unit_price = COALESCE($6,unit_price), reorder_level = COALESCE($7,reorder_level),
         category = COALESCE($8,category)
       WHERE id = $1 RETURNING *`,
      [p.id, b.name, b.sku, b.unit, b.unitCost, b.unitPrice, b.reorderLevel, b.category],
    );
    await audit(req, { orgId: p.org_id, action: 'product.update', resourceType: 'product', resourceId: p.id, oldValues: p, newValues: rows[0] });
    return successResponse(res, rows[0]);
  } catch (err) { next(err); }
});

export default router;
