import express from 'express';
import { body } from 'express-validator';
import { validate } from '../../middleware/validate.js';
import { requireAuth } from '../../middleware/auth.js';
import { query, withTransaction } from '../../config/database.js';
import { successResponse, createdResponse } from '../../utils/response.js';
import { AppError, NotFoundError } from '../../utils/errors.js';
import { audit } from '../audit/audit.service.js';
import { PERMISSIONS as P, assertOutletAccess, isUuid } from '../../services/permissions.js';
import { pagination } from '../../utils/pagination.js';
import { scopedOutletWhere } from './records.shared.js';
import { applyMovement, MOVEMENT_TYPES } from './inventory.service.js';
import { todayIn } from '../../utils/dates.js';
import { randomUUID as uuidv4 } from 'crypto';

const router = express.Router();
router.use(requireAuth);

async function assertProduct(productId, orgId) {
  if (!isUuid(productId)) throw new AppError('Invalid product.', 400);
  const { rows } = await query('SELECT * FROM products WHERE id = $1 AND org_id = $2 AND deleted_at IS NULL', [productId, orgId]);
  if (!rows.length) throw new NotFoundError('Product');
  return rows[0];
}

// GET /api/v1/inventory?outletId=|orgId=&lowOnly=true
router.get('/', async (req, res, next) => {
  try {
    const { where, params } = await scopedOutletWhere(req, P.FRANCHISE_READ);
    let w = `WHERE ${where}`;
    if (req.query.lowOnly === 'true') w += ' AND ib.quantity <= p.reorder_level';
    const { rows } = await query(
      `SELECT ib.id, ib.outlet_id, o.name AS outlet_name, ib.product_id, p.name AS product_name, p.sku, p.unit,
              p.category, p.reorder_level, p.unit_cost, ib.quantity, ib.updated_at,
              (ib.quantity <= p.reorder_level) AS is_low,
              CASE WHEN p.unit_cost IS NULL THEN NULL ELSE ROUND(ib.quantity * p.unit_cost, 2) END AS stock_value
         FROM inventory_balances ib
         JOIN outlets o ON o.id = ib.outlet_id
         JOIN products p ON p.id = ib.product_id AND p.deleted_at IS NULL
        ${w} ORDER BY o.name, p.name`,
      params,
    );
    const valued = rows.filter((r) => r.stock_value != null);
    return res.json({
      success: true,
      data: rows,
      meta: {
        items: rows.length,
        lowStock: rows.filter((r) => r.is_low).length,
        // Valuation only includes products with a known unit cost.
        stockValue: valued.reduce((s, r) => s + Number(r.stock_value), 0),
        unvaluedItems: rows.length - valued.length,
      },
    });
  } catch (err) { next(err); }
});

// GET /api/v1/inventory/movements?outletId=|orgId=&productId=&from=&to=
router.get('/movements', async (req, res, next) => {
  try {
    const { where, params, from, to } = await scopedOutletWhere(req, P.FRANCHISE_READ);
    let w = `WHERE ${where}`;
    if (req.query.productId && isUuid(req.query.productId)) { params.push(req.query.productId); w += ` AND im.product_id = $${params.length}`; }
    if (from) { params.push(from); w += ` AND im.movement_date >= $${params.length}`; }
    if (to)   { params.push(to);   w += ` AND im.movement_date <= $${params.length}`; }
    const { page, limit, offset } = pagination(req.query);
    const { rows } = await query(
      `SELECT im.*, p.name AS product_name, p.sku, o.name AS outlet_name, u.full_name AS moved_by_name
         FROM inventory_movements im
         JOIN products p ON p.id = im.product_id
         JOIN outlets o ON o.id = im.outlet_id
         LEFT JOIN users u ON u.id = im.moved_by
        ${w} ORDER BY im.movement_date DESC, im.created_at DESC
        LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset],
    );
    return successResponse(res, rows, { meta: { page, limit } });
  } catch (err) { next(err); }
});

// POST /api/v1/inventory/movements
router.post('/movements',
  [
    body('outletId').isUUID(),
    body('productId').isUUID(),
    body('movementType').isIn(MOVEMENT_TYPES.filter((t) => !t.startsWith('transfer'))),
    body('quantity').isFloat({ min: -1e9, max: 1e9 }),
    body('unitCost').optional({ values: 'null' }).isFloat({ min: 0 }),
    body('movementDate').optional().isISO8601({ strict: true }),
    body('notes').optional({ values: 'null' }).isString().isLength({ max: 1000 }),
  ],
  validate,
  async (req, res, next) => {
    try {
      const { outletId, productId, movementType, quantity, unitCost, notes, movementDate } = req.body;
      const { outlet, membership } = await assertOutletAccess(req, outletId, P.INVENTORY_WRITE);
      await assertProduct(productId, outlet.org_id);
      if (movementType === 'adjustment' && (!notes || notes.trim().length < 3)) {
        throw new AppError('Stock adjustments require a note explaining the reason.', 422);
      }
      const result = await withTransaction((c) => applyMovement(c, {
        outletId: outlet.id, productId, movementType, quantity, unitCost, notes,
        movementDate: movementDate || todayIn(membership.default_timezone), userId: req.user.id,
      }));
      await audit(req, { orgId: outlet.org_id, action: `inventory.${movementType}`, resourceType: 'inventory_movement', resourceId: result.movement.id, newValues: result.movement });
      return createdResponse(res, result);
    } catch (err) { next(err); }
  },
);

// POST /api/v1/inventory/transfers  { fromOutletId, toOutletId, productId, quantity, notes }
router.post('/transfers',
  [body('fromOutletId').isUUID(), body('toOutletId').isUUID(), body('productId').isUUID(), body('quantity').isFloat({ gt: 0, max: 1e9 })],
  validate,
  async (req, res, next) => {
    try {
      const { fromOutletId, toOutletId, productId, quantity, notes } = req.body;
      if (fromOutletId === toOutletId) throw new AppError('Source and destination outlets must differ.', 422);
      const src = await assertOutletAccess(req, fromOutletId, P.INVENTORY_TRANSFER);
      const dst = await assertOutletAccess(req, toOutletId, P.INVENTORY_TRANSFER);
      if (src.outlet.org_id !== dst.outlet.org_id) throw new AppError('Transfers must stay within one organisation.', 422);
      const product = await assertProduct(productId, src.outlet.org_id);
      const transferId = uuidv4();
      const date = todayIn(src.membership.default_timezone);
      const result = await withTransaction(async (c) => {
        const base = { productId, quantity, unitCost: product.unit_cost, notes, movementDate: date, userId: req.user.id, transferId, referenceType: 'transfer', referenceId: transferId };
        const out = await applyMovement(c, { ...base, outletId: fromOutletId, movementType: 'transfer_out' });
        const inn = await applyMovement(c, { ...base, outletId: toOutletId, movementType: 'transfer_in' });
        return { transferId, out: out.movement, in: inn.movement };
      });
      await audit(req, { orgId: src.outlet.org_id, action: 'inventory.transfer', resourceType: 'inventory_transfer', resourceId: transferId, newValues: { fromOutletId, toOutletId, productId, quantity } });
      return createdResponse(res, result);
    } catch (err) { next(err); }
  },
);

export default router;
