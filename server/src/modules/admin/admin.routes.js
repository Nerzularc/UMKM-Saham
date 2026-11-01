/**
 * Platform administration (superadmin only).
 * These endpoints expose platform health and accounts — never tenant financial
 * figures. Audit entries belonging to organisations are returned without their
 * old/new values; superadmins need an organisation membership to see those.
 */
import express from 'express';
import { body } from 'express-validator';
import { validate } from '../../middleware/validate.js';
import { requireAuth, requireSuperadmin } from '../../middleware/auth.js';
import { query } from '../../config/database.js';
import { successResponse, paginatedResponse } from '../../utils/response.js';
import { AppError, NotFoundError } from '../../utils/errors.js';
import { pagination } from '../../utils/pagination.js';
import { audit } from '../audit/audit.service.js';
import { revokeAllSessions } from '../auth/auth.service.js';
import { permissionMatrix, isUuid } from '../../services/permissions.js';

const router = express.Router();
router.use(requireAuth, requireSuperadmin);

router.get('/stats', async (_req, res, next) => {
  try {
    const { rows } = await query(`
      SELECT
        (SELECT COUNT(*) FROM users WHERE deleted_at IS NULL)::int                         AS users,
        (SELECT COUNT(*) FROM users WHERE deleted_at IS NULL AND is_active = FALSE)::int    AS inactive_users,
        (SELECT COUNT(*) FROM users WHERE last_login_at > NOW() - INTERVAL '30 days')::int  AS active_users_30d,
        (SELECT COUNT(*) FROM organisations WHERE deleted_at IS NULL)::int                 AS organisations,
        (SELECT COUNT(*) FROM organisations WHERE deleted_at IS NULL AND is_active = FALSE)::int AS suspended_organisations,
        (SELECT COUNT(*) FROM portfolios WHERE deleted_at IS NULL)::int                    AS portfolios,
        (SELECT COUNT(*) FROM outlets WHERE deleted_at IS NULL)::int                       AS outlets,
        (SELECT COUNT(*) FROM sessions WHERE revoked_at IS NULL AND expires_at > NOW())::int AS active_sessions,
        (SELECT COUNT(*) FROM audit_events WHERE action IN ('auth.login_failed','auth.totp_failed','auth.login_locked')
            AND created_at > NOW() - INTERVAL '24 hours')::int                             AS failed_logins_24h,
        (SELECT COUNT(*) FROM import_batches WHERE status = 'failed' AND created_at > NOW() - INTERVAL '7 days')::int AS failed_imports_7d,
        (SELECT COUNT(*) FROM sync_jobs WHERE status = 'failed' AND created_at > NOW() - INTERVAL '7 days')::int AS failed_sync_jobs_7d`);
    return successResponse(res, rows[0]);
  } catch (err) { next(err); }
});

router.get('/users', async (req, res, next) => {
  try {
    const { page, limit, offset } = pagination(req.query);
    const params = [];
    let where = 'WHERE u.deleted_at IS NULL';
    if (req.query.q) { params.push(`%${String(req.query.q).slice(0, 100)}%`); where += ` AND (u.email ILIKE $1 OR u.full_name ILIKE $1)`; }
    const [{ rows }, { rows: cr }] = await Promise.all([
      query(
        `SELECT u.id, u.email, u.full_name, u.is_active, u.is_superadmin, u.two_factor_enabled, u.created_at, u.last_login_at,
                (SELECT COUNT(*) FROM org_memberships om WHERE om.user_id = u.id AND om.is_active)::int AS org_count
           FROM users u ${where} ORDER BY u.created_at DESC
          LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, limit, offset],
      ),
      query(`SELECT COUNT(*) FROM users u ${where}`, params),
    ]);
    return paginatedResponse(res, rows, { total: parseInt(cr[0].count, 10), page, limit });
  } catch (err) { next(err); }
});

router.patch('/users/:id', [body('isActive').isBoolean()], validate, async (req, res, next) => {
  try {
    if (!isUuid(req.params.id)) throw new NotFoundError('User');
    if (req.params.id === req.user.id) throw new AppError('You cannot change your own account status.', 400);
    const { rows } = await query('UPDATE users SET is_active = $2 WHERE id = $1 AND deleted_at IS NULL RETURNING id, email, is_active', [req.params.id, req.body.isActive]);
    if (!rows.length) throw new NotFoundError('User');
    if (!req.body.isActive) await revokeAllSessions(req.params.id, req.user.id);
    await audit(req, { action: req.body.isActive ? 'admin.user_reactivated' : 'admin.user_suspended', resourceType: 'user', resourceId: req.params.id, newValues: rows[0] });
    return successResponse(res, rows[0]);
  } catch (err) { next(err); }
});

router.get('/organisations', async (_req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT o.id, o.name, o.slug, o.is_active, o.modules_enabled, o.created_at, u.email AS owner_email,
              (SELECT COUNT(*) FROM org_memberships om WHERE om.org_id = o.id AND om.is_active)::int AS member_count,
              (SELECT COUNT(*) FROM outlets ot WHERE ot.org_id = o.id AND ot.deleted_at IS NULL)::int AS outlet_count
         FROM organisations o JOIN users u ON u.id = o.owner_id
        WHERE o.deleted_at IS NULL ORDER BY o.created_at DESC`,
    );
    return successResponse(res, rows);
  } catch (err) { next(err); }
});

router.patch('/organisations/:id', [body('isActive').isBoolean()], validate, async (req, res, next) => {
  try {
    if (!isUuid(req.params.id)) throw new NotFoundError('Organisation');
    const { rows } = await query('UPDATE organisations SET is_active = $2 WHERE id = $1 AND deleted_at IS NULL RETURNING id, name, is_active', [req.params.id, req.body.isActive]);
    if (!rows.length) throw new NotFoundError('Organisation');
    await audit(req, { orgId: req.params.id, action: req.body.isActive ? 'admin.org_reactivated' : 'admin.org_suspended', resourceType: 'organisation', resourceId: req.params.id, newValues: rows[0] });
    return successResponse(res, rows[0]);
  } catch (err) { next(err); }
});

router.get('/audit', async (req, res, next) => {
  try {
    const { page, limit, offset } = pagination(req.query, { defaultLimit: 100, maxLimit: 500 });
    const params = [];
    let where = 'WHERE 1=1';
    if (req.query.orgId && isUuid(req.query.orgId)) { params.push(req.query.orgId); where += ` AND org_id = $${params.length}`; }
    if (req.query.action) { params.push(`${req.query.action}%`); where += ` AND action LIKE $${params.length}`; }
    if (req.query.security === 'true') where += " AND (action LIKE 'auth.%' OR action LIKE 'admin.%' OR action LIKE 'member.%')";
    const [{ rows }, { rows: cr }] = await Promise.all([
      query(
        `SELECT id, org_id, actor_id, actor_email, action, resource_type, resource_id, ip_address, user_agent, created_at,
                CASE WHEN org_id IS NULL THEN old_values END AS old_values,
                CASE WHEN org_id IS NULL THEN new_values END AS new_values,
                CASE WHEN org_id IS NULL THEN metadata END AS metadata
           FROM audit_events ${where} ORDER BY created_at DESC
          LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, limit, offset],
      ),
      query(`SELECT COUNT(*) FROM audit_events ${where}`, params),
    ]);
    return paginatedResponse(res, rows, { total: parseInt(cr[0].count, 10), page, limit });
  } catch (err) { next(err); }
});

router.get('/jobs', async (_req, res, next) => {
  try {
    const [{ rows: sync }, { rows: imports }] = await Promise.all([
      query(`SELECT id, job_type, status, started_at, completed_at, records_synced, error_message, metadata
               FROM sync_jobs ORDER BY created_at DESC LIMIT 50`),
      query(`SELECT id, module, entity_type, status, total_rows, imported_rows, error_rows, duplicate_rows, created_at, completed_at, error_message
               FROM import_batches ORDER BY created_at DESC LIMIT 50`),
    ]);
    return successResponse(res, { syncJobs: sync, imports });
  } catch (err) { next(err); }
});

router.get('/settings', async (_req, res, next) => {
  try {
    const { rows } = await query('SELECT key, value, updated_at FROM platform_settings ORDER BY key');
    return successResponse(res, { settings: rows, roles: permissionMatrix() });
  } catch (err) { next(err); }
});

router.put('/settings/:key', [body('value').exists()], validate, async (req, res, next) => {
  try {
    const allowed = { registration_enabled: 'boolean', maintenance_banner: 'string' };
    const type = allowed[req.params.key];
    if (!type || typeof req.body.value !== type) throw new AppError('Unknown setting or invalid value.', 422);
    const { rows: before } = await query('SELECT value FROM platform_settings WHERE key = $1', [req.params.key]);
    const { rows } = await query(
      `INSERT INTO platform_settings (key, value, updated_by, updated_at) VALUES ($1, $2, $3, NOW())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = NOW()
       RETURNING key, value, updated_at`,
      [req.params.key, JSON.stringify(req.body.value), req.user.id],
    );
    await audit(req, { action: 'admin.setting_changed', resourceType: 'platform_setting', resourceId: req.params.key, oldValues: before[0] || null, newValues: rows[0] });
    return successResponse(res, rows[0]);
  } catch (err) { next(err); }
});

export default router;
