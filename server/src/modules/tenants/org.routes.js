import express from 'express';
import { body } from 'express-validator';
import { validate } from '../../middleware/validate.js';
import { requireAuth } from '../../middleware/auth.js';
import { query, withTransaction } from '../../config/database.js';
import { successResponse, createdResponse } from '../../utils/response.js';
import { AppError, NotFoundError, ForbiddenError } from '../../utils/errors.js';
import { audit } from '../audit/audit.service.js';
import {
  PERMISSIONS as P, requirePermission, getMembership, ASSIGNABLE_ROLES, permissionMatrix, isUuid,
} from '../../services/permissions.js';
import { randomUUID as uuidv4 } from 'crypto';

const router = express.Router();
router.use(requireAuth);

const MODULES = ['stocks', 'franchise'];

// GET /api/v1/organisations — organisations the caller belongs to
router.get('/', async (req, res) => successResponse(res, req.memberships));

// GET /api/v1/organisations/permissions — role → permission matrix (documentation)
router.get('/permissions', (_req, res) => successResponse(res, permissionMatrix()));

// POST /api/v1/organisations — the creator becomes organisation owner
router.post('/',
  [
    body('name').trim().isLength({ min: 2, max: 255 }),
    body('slug').optional().trim().isLength({ min: 2, max: 100 }).matches(/^[a-z0-9-]+$/),
    body('defaultCurrency').optional().isLength({ min: 3, max: 3 }).isAlpha(),
    body('modulesEnabled').optional().isArray(),
  ],
  validate,
  async (req, res, next) => {
    try {
      const { name, slug, description, defaultCurrency = 'IDR', locale = 'id', modulesEnabled = MODULES } = req.body;
      const modules = modulesEnabled.filter((m) => MODULES.includes(m));
      const orgId = uuidv4();
      const orgSlug = slug || `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50)}-${orgId.slice(0, 6)}`;
      const org = await withTransaction(async (c) => {
        const { rows } = await c.query(
          `INSERT INTO organisations (id, name, slug, description, default_currency, locale, owner_id, modules_enabled)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
          [orgId, name, orgSlug, description || null, defaultCurrency.toUpperCase(), locale, req.user.id, JSON.stringify(modules)],
        );
        await c.query(
          `INSERT INTO org_memberships (id, org_id, user_id, role_id, is_active, joined_at)
           SELECT $1, $2, $3, id, TRUE, NOW() FROM roles WHERE name = 'org_owner'`,
          [uuidv4(), orgId, req.user.id],
        );
        return rows[0];
      });
      await audit(req, { orgId, action: 'organisation.create', resourceType: 'organisation', resourceId: orgId, newValues: org });
      return createdResponse(res, org);
    } catch (err) { next(err); }
  },
);

// GET /api/v1/organisations/:orgId
router.get('/:orgId', async (req, res, next) => {
  try {
    const membership = getMembership(req, req.params.orgId);
    const { rows } = await query(
      `SELECT id, name, slug, description, country, default_currency, default_timezone, locale,
              modules_enabled, settings, is_active, owner_id, created_at
         FROM organisations WHERE id = $1`,
      [req.params.orgId],
    );
    return successResponse(res, { ...rows[0], myRole: membership.role_name });
  } catch (err) { next(err); }
});

// PATCH /api/v1/organisations/:orgId — settings, modules, approvals
router.patch('/:orgId',
  [
    body('name').optional().trim().isLength({ min: 2, max: 255 }),
    body('defaultTimezone').optional().isString().isLength({ max: 50 }),
    body('modulesEnabled').optional().isArray(),
    body('approvals').optional().isObject(),
    body('approvals.enabled').optional().isBoolean(),
    body('approvals.separationOfDuties').optional().isBoolean(),
    body('approvals.actions').optional().isArray(),
  ],
  validate,
  async (req, res, next) => {
    try {
      const { orgId } = req.params;
      requirePermission(req, orgId, P.ORG_MANAGE);
      const { name, description, defaultTimezone, modulesEnabled, approvals } = req.body;
      if (defaultTimezone) {
        try { new Intl.DateTimeFormat('en', { timeZone: defaultTimezone }); } catch { throw new AppError('Unknown timezone.', 422); }
      }
      const { rows: before } = await query('SELECT * FROM organisations WHERE id = $1', [orgId]);
      const settings = { ...(before[0].settings || {}) };
      if (approvals) {
        const allowed = ['sales.update', 'sales.delete', 'expenses.update', 'expenses.delete'];
        settings.approvals = {
          ...(settings.approvals || {}),
          ...(approvals.enabled !== undefined && { enabled: approvals.enabled }),
          ...(approvals.separationOfDuties !== undefined && { separationOfDuties: approvals.separationOfDuties }),
          ...(approvals.actions && { actions: approvals.actions.filter((a) => allowed.includes(a)) }),
        };
      }
      const modules = modulesEnabled ? JSON.stringify(modulesEnabled.filter((m) => MODULES.includes(m))) : null;
      const { rows } = await query(
        `UPDATE organisations SET name = COALESCE($2,name), description = COALESCE($3,description),
           default_timezone = COALESCE($4,default_timezone), modules_enabled = COALESCE($5::jsonb, modules_enabled),
           settings = $6
         WHERE id = $1 RETURNING *`,
        [orgId, name, description, defaultTimezone, modules, JSON.stringify(settings)],
      );
      await audit(req, { orgId, action: 'organisation.update', resourceType: 'organisation', resourceId: orgId, oldValues: before[0], newValues: rows[0] });
      return successResponse(res, rows[0]);
    } catch (err) { next(err); }
  },
);

// GET /api/v1/organisations/:orgId/members
router.get('/:orgId/members', async (req, res, next) => {
  try {
    requirePermission(req, req.params.orgId, P.MEMBERS_READ);
    const { rows } = await query(
      `SELECT u.id, u.email, u.full_name, r.name AS role_name, om.is_active, om.joined_at,
              (SELECT COALESCE(json_agg(json_build_object('outletId', oa.outlet_id, 'outletName', o.name, 'role', oa.role)), '[]')
                 FROM outlet_assignments oa JOIN outlets o ON o.id = oa.outlet_id
                WHERE oa.user_id = u.id AND oa.is_active = TRUE AND o.org_id = om.org_id) AS outlets
         FROM org_memberships om
         JOIN users u ON u.id = om.user_id AND u.deleted_at IS NULL
         JOIN roles r ON r.id = om.role_id
        WHERE om.org_id = $1
        ORDER BY CASE r.name WHEN 'org_owner' THEN 1 WHEN 'manager' THEN 2 ELSE 3 END, u.full_name`,
      [req.params.orgId],
    );
    return successResponse(res, rows);
  } catch (err) { next(err); }
});

// POST /api/v1/organisations/:orgId/members  { email, role: manager|staff }
// Adds an existing platform user. org_owner and superadmin can never be granted here.
router.post('/:orgId/members',
  [body('email').isEmail().normalizeEmail({ gmail_remove_dots: false }), body('role').isIn(ASSIGNABLE_ROLES)],
  validate,
  async (req, res, next) => {
    try {
      const { orgId } = req.params;
      requirePermission(req, orgId, P.MEMBERS_MANAGE);
      const { email, role } = req.body;
      const { rows: users } = await query('SELECT id, email FROM users WHERE email = $1 AND deleted_at IS NULL AND is_active = TRUE', [email]);
      if (!users.length) throw new NotFoundError('User (they must register first)');
      const target = users[0];
      const { rows: existing } = await query(
        `SELECT om.*, r.name AS role_name FROM org_memberships om JOIN roles r ON r.id = om.role_id
          WHERE om.org_id = $1 AND om.user_id = $2`, [orgId, target.id],
      );
      if (existing[0]?.role_name === 'org_owner') throw new ForbiddenError('The organisation owner cannot be changed here.');
      const { rows } = await query(
        `INSERT INTO org_memberships (id, org_id, user_id, role_id, invited_by, is_active, joined_at)
         SELECT $1, $2, $3, r.id, $4, TRUE, NOW() FROM roles r WHERE r.name = $5
         ON CONFLICT (org_id, user_id) DO UPDATE SET role_id = EXCLUDED.role_id, is_active = TRUE
         RETURNING *`,
        [uuidv4(), orgId, target.id, req.user.id, role],
      );
      await audit(req, {
        orgId, action: existing.length ? 'member.role_changed' : 'member.added', resourceType: 'org_membership',
        resourceId: rows[0].id, oldValues: existing[0] ? { role: existing[0].role_name, isActive: existing[0].is_active } : null,
        newValues: { userId: target.id, email: target.email, role },
      });
      return createdResponse(res, { userId: target.id, email: target.email, role });
    } catch (err) { next(err); }
  },
);

// PATCH /api/v1/organisations/:orgId/members/:userId  { role?, isActive? }
router.patch('/:orgId/members/:userId',
  [body('role').optional().isIn(ASSIGNABLE_ROLES), body('isActive').optional().isBoolean()],
  validate,
  async (req, res, next) => {
    try {
      const { orgId, userId } = req.params;
      requirePermission(req, orgId, P.MEMBERS_MANAGE);
      if (!isUuid(userId)) throw new NotFoundError('Member');
      if (userId === req.user.id) throw new ForbiddenError('You cannot change your own membership.');
      const { rows: existing } = await query(
        `SELECT om.*, r.name AS role_name FROM org_memberships om JOIN roles r ON r.id = om.role_id
          WHERE om.org_id = $1 AND om.user_id = $2`, [orgId, userId],
      );
      if (!existing.length) throw new NotFoundError('Member');
      if (existing[0].role_name === 'org_owner') throw new ForbiddenError('The organisation owner cannot be changed here.');
      const { role, isActive } = req.body;
      const { rows } = await query(
        `UPDATE org_memberships SET
           role_id = COALESCE((SELECT id FROM roles WHERE name = $3), role_id),
           is_active = COALESCE($4, is_active)
         WHERE org_id = $1 AND user_id = $2 RETURNING *`,
        [orgId, userId, role || null, isActive],
      );
      if (isActive === false) {
        await query(
          `UPDATE outlet_assignments SET is_active = FALSE
            WHERE user_id = $1 AND outlet_id IN (SELECT id FROM outlets WHERE org_id = $2)`,
          [userId, orgId],
        );
      }
      await audit(req, {
        orgId, action: isActive === false ? 'member.deactivated' : 'member.updated', resourceType: 'org_membership',
        resourceId: rows[0].id, oldValues: { role: existing[0].role_name, isActive: existing[0].is_active }, newValues: { role, isActive },
      });
      return successResponse(res, rows[0]);
    } catch (err) { next(err); }
  },
);

export default router;
