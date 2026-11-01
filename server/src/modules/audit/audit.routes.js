import express from 'express';
import { requireAuth } from '../../middleware/auth.js';
import { query } from '../../config/database.js';
import { paginatedResponse } from '../../utils/response.js';
import { requirePermission, PERMISSIONS as P } from '../../services/permissions.js';
import { pagination } from '../../utils/pagination.js';
import { isIsoDate } from '../../utils/dates.js';

const router = express.Router();
router.use(requireAuth);

/**
 * GET /api/v1/audit?orgId=&action=&from=&to=
 * Without orgId: the caller's own actions. With orgId: organisation events
 * (requires org.audit.read). Platform-wide audit lives under /admin/audit.
 */
router.get('/', async (req, res, next) => {
  try {
    const { orgId, action, resourceType, from, to } = req.query;
    const { page, limit, offset } = pagination(req.query, { defaultLimit: 50, maxLimit: 200 });
    const params = [];
    let where;
    if (orgId) {
      requirePermission(req, orgId, P.AUDIT_READ);
      params.push(orgId);
      where = `WHERE ae.org_id = $1`;
    } else {
      params.push(req.user.id);
      where = `WHERE ae.actor_id = $1`;
    }
    if (action)       { params.push(`${action}%`);  where += ` AND ae.action LIKE $${params.length}`; }
    if (resourceType) { params.push(resourceType);  where += ` AND ae.resource_type = $${params.length}`; }
    if (from && isIsoDate(from)) { params.push(from); where += ` AND ae.created_at >= $${params.length}::date`; }
    if (to && isIsoDate(to))     { params.push(to);   where += ` AND ae.created_at < ($${params.length}::date + 1)`; }

    const [{ rows }, { rows: cr }] = await Promise.all([
      query(
        `SELECT ae.id, ae.org_id, ae.actor_id, ae.actor_email, ae.action, ae.resource_type, ae.resource_id,
                ae.old_values, ae.new_values, ae.metadata, ae.created_at
           FROM audit_events ae ${where}
          ORDER BY ae.created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, limit, offset],
      ),
      query(`SELECT COUNT(*) FROM audit_events ae ${where}`, params),
    ]);
    return paginatedResponse(res, rows, { total: parseInt(cr[0].count, 10), page, limit });
  } catch (err) { next(err); }
});

export default router;
