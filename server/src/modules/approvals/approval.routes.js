import express from 'express';
import { body } from 'express-validator';
import { validate } from '../../middleware/validate.js';
import { requireAuth } from '../../middleware/auth.js';
import { query } from '../../config/database.js';
import { successResponse } from '../../utils/response.js';
import { PERMISSIONS as P, requirePermission, getMembership, roleHas } from '../../services/permissions.js';
import { reviewApproval } from './approval.service.js';
import { NotFoundError } from '../../utils/errors.js';

const router = express.Router();
router.use(requireAuth);

// GET /api/v1/approvals?orgId=&status=pending
// Reviewers see all requests of the organisation; others see their own requests.
router.get('/', async (req, res, next) => {
  try {
    const { orgId, status } = req.query;
    const membership = getMembership(req, orgId);
    const params = [orgId];
    let where = 'WHERE ca.org_id = $1';
    if (!roleHas(membership.role_name, P.APPROVALS_REVIEW)) { params.push(req.user.id); where += ` AND ca.requested_by = $${params.length}`; }
    if (['pending', 'approved', 'rejected'].includes(status)) { params.push(status); where += ` AND ca.status = $${params.length}`; }
    const { rows } = await query(
      `SELECT ca.*, ru.full_name AS requested_by_name, rv.full_name AS reviewed_by_name
         FROM change_approvals ca
         JOIN users ru ON ru.id = ca.requested_by
         LEFT JOIN users rv ON rv.id = ca.reviewed_by
        ${where} ORDER BY ca.created_at DESC LIMIT 200`,
      params,
    );
    return successResponse(res, rows);
  } catch (err) { next(err); }
});

for (const [path, decision] of [['approve', 'approved'], ['reject', 'rejected']]) {
  router.post(`/:id/${path}`, [body('notes').optional().isString().isLength({ max: 1000 })], validate, async (req, res, next) => {
    try {
      const { rows } = await query('SELECT org_id FROM change_approvals WHERE id = $1', [req.params.id]).catch(() => ({ rows: [] }));
      if (!rows.length) throw new NotFoundError('Approval');
      requirePermission(req, rows[0].org_id, P.APPROVALS_REVIEW);
      const result = await reviewApproval(req, req.params.id, decision, req.body.notes);
      return successResponse(res, result);
    } catch (err) { next(err); }
  });
}

export default router;
