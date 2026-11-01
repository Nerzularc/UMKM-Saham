import express from 'express';
import { body } from 'express-validator';
import { validate } from '../../middleware/validate.js';
import { requireAuth } from '../../middleware/auth.js';
import { query } from '../../config/database.js';
import { successResponse, createdResponse, paginatedResponse } from '../../utils/response.js';
import { AppError } from '../../utils/errors.js';
import { audit } from '../audit/audit.service.js';
import { PERMISSIONS as P, assertOutletAccess } from '../../services/permissions.js';
import { pagination, sortClause } from '../../utils/pagination.js';
import { requiresApproval, createApproval } from '../approvals/approval.service.js';
import { scopedOutletWhere, loadRecord } from './records.shared.js';
import { todayIn } from '../../utils/dates.js';
import { randomUUID as uuidv4 } from 'crypto';

const router = express.Router();
router.use(requireAuth);

const money = (f) => body(f).isFloat({ min: 0, max: 1e15 }).withMessage(`${f} must be a non-negative amount.`);

// GET /api/v1/sales?orgId=|outletId=&from=&to=&page=&limit=&sort=
router.get('/', async (req, res, next) => {
  try {
    const { where, params, from, to } = await scopedOutletWhere(req, P.FRANCHISE_READ);
    let w = `WHERE ${where} AND sr.deleted_at IS NULL`;
    if (from) { params.push(from); w += ` AND sr.sale_date >= $${params.length}`; }
    if (to)   { params.push(to);   w += ` AND sr.sale_date <= $${params.length}`; }
    const { page, limit, offset } = pagination(req.query, { defaultLimit: 50 });
    const order = sortClause(req.query, { date: 'sr.sale_date', net: 'sr.net_sales', outlet: 'o.name' }, 'sr.sale_date DESC, o.name');
    const [{ rows }, { rows: agg }] = await Promise.all([
      query(
        `SELECT sr.*, o.name AS outlet_name, o.code AS outlet_code
           FROM sales_records sr JOIN outlets o ON o.id = sr.outlet_id
          ${w} ${order} LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, limit, offset],
      ),
      query(
        `SELECT COUNT(*) AS count, COALESCE(SUM(sr.gross_sales),0) gross, COALESCE(SUM(sr.discounts),0) disc,
                COALESCE(SUM(sr.returns),0) ret, COALESCE(SUM(sr.net_sales),0) net,
                COALESCE(SUM(sr.transaction_count),0) tx
           FROM sales_records sr JOIN outlets o ON o.id = sr.outlet_id ${w}`,
        params,
      ),
    ]);
    const a = agg[0];
    res.json({
      success: true,
      data: rows,
      meta: {
        total: parseInt(a.count, 10), page, limit, totalPages: Math.ceil(a.count / limit),
        totals: { grossSales: a.gross, discounts: a.disc, returns: a.ret, netSales: a.net, transactionCount: parseInt(a.tx, 10) },
      },
    });
  } catch (err) { next(err); }
});

// POST /api/v1/sales
router.post('/',
  [
    body('outletId').isUUID(),
    body('saleDate').isISO8601({ strict: true }),
    money('grossSales'),
    money('discounts').optional(),
    money('returns').optional(),
    body('transactionCount').optional().isInt({ min: 0, max: 10_000_000 }),
    body('notes').optional({ values: 'null' }).isString().isLength({ max: 2000 }),
  ],
  validate,
  async (req, res, next) => {
    try {
      const { outletId, saleDate, grossSales, discounts = 0, returns = 0, transactionCount = 0, notes } = req.body;
      const { outlet, membership } = await assertOutletAccess(req, outletId, P.SALES_WRITE);
      if (Number(discounts) + Number(returns) > Number(grossSales)) {
        throw new AppError('Discounts plus returns cannot exceed gross sales.', 422);
      }
      if (saleDate > todayIn(membership.default_timezone)) throw new AppError('Sale date cannot be in the future.', 422);
      const { rows } = await query(
        `INSERT INTO sales_records (id, outlet_id, sale_date, gross_sales, discounts, returns,
                                    transaction_count, currency, notes, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'IDR',$8,$9) RETURNING *`,
        [uuidv4(), outlet.id, saleDate, grossSales, discounts, returns, transactionCount, notes || null, req.user.id],
      );
      await audit(req, { orgId: outlet.org_id, action: 'sales.create', resourceType: 'sales_record', resourceId: rows[0].id, newValues: rows[0] });
      return createdResponse(res, rows[0]);
    } catch (err) { next(err); }
  },
);

// PUT /api/v1/sales/:id  { grossSales?, discounts?, returns?, transactionCount?, notes?, reason }
router.put('/:id',
  [money('grossSales').optional(), money('discounts').optional(), money('returns').optional(),
    body('transactionCount').optional().isInt({ min: 0 }), body('reason').optional().isString().isLength({ max: 1000 })],
  validate,
  async (req, res, next) => {
    try {
      const { record, outlet } = await loadRecord(req, 'sales_records', req.params.id, P.SALES_WRITE, 'Sales record');
      const { grossSales, discounts, returns, transactionCount, notes, reason } = req.body;
      const gross = Number(grossSales ?? record.gross_sales);
      if (Number(discounts ?? record.discounts) + Number(returns ?? record.returns) > gross) {
        throw new AppError('Discounts plus returns cannot exceed gross sales.', 422);
      }
      const proposed = { grossSales, discounts, returns, transactionCount, notes };

      if (await requiresApproval(outlet.org_id, 'sales.update')) {
        const approval = await createApproval(req, {
          orgId: outlet.org_id, resourceType: 'sales_record', resourceId: record.id, action: 'update',
          oldValues: record, newValues: proposed, reason,
        });
        return res.status(202).json({ success: true, message: 'Change submitted for approval.', data: { approval } });
      }

      const { rows } = await query(
        `UPDATE sales_records SET gross_sales = COALESCE($2, gross_sales), discounts = COALESCE($3, discounts),
           returns = COALESCE($4, returns), transaction_count = COALESCE($5, transaction_count), notes = COALESCE($6, notes)
         WHERE id = $1 RETURNING *`,
        [record.id, grossSales, discounts, returns, transactionCount, notes],
      );
      await audit(req, { orgId: outlet.org_id, action: 'sales.update', resourceType: 'sales_record', resourceId: record.id, oldValues: record, newValues: rows[0], metadata: reason ? { reason } : null });
      return successResponse(res, rows[0]);
    } catch (err) { next(err); }
  },
);

// DELETE /api/v1/sales/:id  (soft delete; body/query may carry a reason)
router.delete('/:id', async (req, res, next) => {
  try {
    const { record, outlet } = await loadRecord(req, 'sales_records', req.params.id, P.SALES_WRITE, 'Sales record');
    const reason = req.body?.reason || req.query.reason;
    if (await requiresApproval(outlet.org_id, 'sales.delete')) {
      const approval = await createApproval(req, {
        orgId: outlet.org_id, resourceType: 'sales_record', resourceId: record.id, action: 'delete', oldValues: record, reason,
      });
      return res.status(202).json({ success: true, message: 'Deletion submitted for approval.', data: { approval } });
    }
    await query('UPDATE sales_records SET deleted_at = NOW() WHERE id = $1', [record.id]);
    await audit(req, { orgId: outlet.org_id, action: 'sales.delete', resourceType: 'sales_record', resourceId: record.id, oldValues: record, metadata: reason ? { reason } : null });
    return res.status(204).send();
  } catch (err) { next(err); }
});

export default router;
