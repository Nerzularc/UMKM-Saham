import express from 'express';
import { body } from 'express-validator';
import { validate } from '../../middleware/validate.js';
import { requireAuth } from '../../middleware/auth.js';
import { query } from '../../config/database.js';
import { successResponse, createdResponse } from '../../utils/response.js';
import { AppError, NotFoundError } from '../../utils/errors.js';
import { audit } from '../audit/audit.service.js';
import { PERMISSIONS as P, assertOutletAccess, getMembership, requirePermission, isUuid } from '../../services/permissions.js';
import { pagination, sortClause } from '../../utils/pagination.js';
import { requiresApproval, createApproval } from '../approvals/approval.service.js';
import { scopedOutletWhere, loadRecord } from './records.shared.js';
import { randomUUID as uuidv4 } from 'crypto';

const router = express.Router();
router.use(requireAuth);

const CATEGORY_TYPES = ['cogs', 'operating', 'non_operating', 'tax'];

/** A category is usable by an org if it is a platform default or belongs to that org. */
async function assertCategory(categoryId, orgId) {
  if (!isUuid(categoryId)) throw new AppError('Invalid expense category.', 400);
  const { rows } = await query(
    'SELECT id FROM expense_categories WHERE id = $1 AND is_active = TRUE AND (org_id IS NULL OR org_id = $2)',
    [categoryId, orgId],
  );
  if (!rows.length) throw new NotFoundError('Expense category');
}

// GET /api/v1/expenses?orgId=|outletId=&from=&to=&categoryType=&categoryId=
router.get('/', async (req, res, next) => {
  try {
    const { where, params, from, to } = await scopedOutletWhere(req, P.FRANCHISE_READ);
    const { categoryType, categoryId } = req.query;
    let w = `WHERE ${where} AND oe.deleted_at IS NULL`;
    if (from) { params.push(from); w += ` AND oe.expense_date >= $${params.length}`; }
    if (to)   { params.push(to);   w += ` AND oe.expense_date <= $${params.length}`; }
    if (CATEGORY_TYPES.includes(categoryType)) { params.push(categoryType); w += ` AND ec.category_type = $${params.length}`; }
    if (categoryId && isUuid(categoryId)) { params.push(categoryId); w += ` AND ec.id = $${params.length}`; }
    const { page, limit, offset } = pagination(req.query);
    const order = sortClause(req.query, { date: 'oe.expense_date', amount: 'oe.amount', outlet: 'o.name' }, 'oe.expense_date DESC, o.name');
    const from_ = `FROM operating_expenses oe
       JOIN expense_categories ec ON ec.id = oe.expense_category_id
       JOIN outlets o ON o.id = oe.outlet_id`;
    const [{ rows }, { rows: agg }, { rows: byCat }] = await Promise.all([
      query(`SELECT oe.*, ec.name AS category_name, ec.code AS category_code, ec.category_type, o.name AS outlet_name
             ${from_} ${w} ${order} LIMIT $${params.length + 1} OFFSET $${params.length + 2}`, [...params, limit, offset]),
      query(`SELECT COUNT(*) count, COALESCE(SUM(oe.amount),0) total ${from_} ${w}`, params),
      query(`SELECT ec.category_type, ec.name, SUM(oe.amount) amount ${from_} ${w} GROUP BY 1,2 ORDER BY 3 DESC`, params),
    ]);
    res.json({
      success: true,
      data: rows,
      meta: { total: parseInt(agg[0].count, 10), page, limit, totalPages: Math.ceil(agg[0].count / limit), totalAmount: agg[0].total, byCategory: byCat },
    });
  } catch (err) { next(err); }
});

// GET /api/v1/expenses/categories?orgId=
router.get('/categories', async (req, res, next) => {
  try {
    const { orgId } = req.query;
    getMembership(req, orgId);
    const { rows } = await query(
      `SELECT * FROM expense_categories WHERE is_active = TRUE AND (org_id IS NULL OR org_id = $1)
       ORDER BY CASE category_type WHEN 'cogs' THEN 1 WHEN 'operating' THEN 2 WHEN 'non_operating' THEN 3 ELSE 4 END, name`,
      [orgId],
    );
    return successResponse(res, rows);
  } catch (err) { next(err); }
});

// POST /api/v1/expenses/categories — organisation-specific chart of accounts
router.post('/categories',
  [body('orgId').isUUID(), body('name').trim().isLength({ min: 1, max: 100 }), body('categoryType').isIn(CATEGORY_TYPES), body('code').optional().trim().isLength({ max: 50 })],
  validate,
  async (req, res, next) => {
    try {
      const { orgId, name, code, categoryType, description } = req.body;
      requirePermission(req, orgId, P.STRUCTURE_MANAGE);
      const { rows } = await query(
        `INSERT INTO expense_categories (id, org_id, name, code, category_type, description)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [uuidv4(), orgId, name, code || null, categoryType, description || null],
      );
      await audit(req, { orgId, action: 'expense_category.create', resourceType: 'expense_category', resourceId: rows[0].id, newValues: rows[0] });
      return createdResponse(res, rows[0]);
    } catch (err) { next(err); }
  },
);

// POST /api/v1/expenses
router.post('/',
  [
    body('outletId').isUUID(),
    body('expenseCategoryId').isUUID(),
    body('expenseDate').isISO8601({ strict: true }),
    body('amount').isFloat({ min: 0, max: 1e15 }),
    body('description').optional({ values: 'null' }).isString().isLength({ max: 2000 }),
    body('reference').optional({ values: 'null' }).isString().isLength({ max: 255 }),
  ],
  validate,
  async (req, res, next) => {
    try {
      const { outletId, expenseCategoryId, expenseDate, amount, description, reference } = req.body;
      const { outlet } = await assertOutletAccess(req, outletId, P.EXPENSES_WRITE);
      await assertCategory(expenseCategoryId, outlet.org_id);
      const { rows } = await query(
        `INSERT INTO operating_expenses
           (id, outlet_id, expense_category_id, expense_date, amount, currency, description, reference, created_by)
         VALUES ($1,$2,$3,$4,$5,'IDR',$6,$7,$8) RETURNING *`,
        [uuidv4(), outlet.id, expenseCategoryId, expenseDate, amount, description || null, reference || null, req.user.id],
      );
      await audit(req, { orgId: outlet.org_id, action: 'expense.create', resourceType: 'operating_expense', resourceId: rows[0].id, newValues: rows[0] });
      return createdResponse(res, rows[0]);
    } catch (err) { next(err); }
  },
);

// PUT /api/v1/expenses/:id
router.put('/:id',
  [body('amount').optional().isFloat({ min: 0 }), body('expenseDate').optional().isISO8601({ strict: true }), body('expenseCategoryId').optional().isUUID()],
  validate,
  async (req, res, next) => {
    try {
      const { record, outlet } = await loadRecord(req, 'operating_expenses', req.params.id, P.EXPENSES_WRITE, 'Expense');
      const { amount, expenseDate, description, expenseCategoryId, reason } = req.body;
      if (expenseCategoryId) await assertCategory(expenseCategoryId, outlet.org_id);
      if (await requiresApproval(outlet.org_id, 'expenses.update')) {
        const approval = await createApproval(req, {
          orgId: outlet.org_id, resourceType: 'operating_expense', resourceId: record.id, action: 'update',
          oldValues: record, newValues: { amount, expenseDate, description, expenseCategoryId }, reason,
        });
        return res.status(202).json({ success: true, message: 'Change submitted for approval.', data: { approval } });
      }
      const { rows } = await query(
        `UPDATE operating_expenses SET amount = COALESCE($2, amount), expense_date = COALESCE($3, expense_date),
           description = COALESCE($4, description), expense_category_id = COALESCE($5, expense_category_id)
         WHERE id = $1 RETURNING *`,
        [record.id, amount, expenseDate, description, expenseCategoryId],
      );
      await audit(req, { orgId: outlet.org_id, action: 'expense.update', resourceType: 'operating_expense', resourceId: record.id, oldValues: record, newValues: rows[0], metadata: reason ? { reason } : null });
      return successResponse(res, rows[0]);
    } catch (err) { next(err); }
  },
);

// DELETE /api/v1/expenses/:id
router.delete('/:id', async (req, res, next) => {
  try {
    const { record, outlet } = await loadRecord(req, 'operating_expenses', req.params.id, P.EXPENSES_WRITE, 'Expense');
    const reason = req.body?.reason || req.query.reason;
    if (await requiresApproval(outlet.org_id, 'expenses.delete')) {
      const approval = await createApproval(req, {
        orgId: outlet.org_id, resourceType: 'operating_expense', resourceId: record.id, action: 'delete', oldValues: record, reason,
      });
      return res.status(202).json({ success: true, message: 'Deletion submitted for approval.', data: { approval } });
    }
    await query('UPDATE operating_expenses SET deleted_at = NOW() WHERE id = $1', [record.id]);
    await audit(req, { orgId: outlet.org_id, action: 'expense.delete', resourceType: 'operating_expense', resourceId: record.id, oldValues: record, metadata: reason ? { reason } : null });
    return res.status(204).send();
  } catch (err) { next(err); }
});

export default router;
