import express from 'express';
import { body } from 'express-validator';
import { validate } from '../../middleware/validate.js';
import { requireAuth } from '../../middleware/auth.js';
import { query } from '../../config/database.js';
import { successResponse } from '../../utils/response.js';
import { audit } from '../audit/audit.service.js';
import { AppError } from '../../utils/errors.js';

const router = express.Router();
router.use(requireAuth);

// GET /api/v1/users/me
router.get('/me', async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT id, email, full_name, avatar_url, locale, timezone, is_superadmin, two_factor_enabled, created_at, last_login_at
         FROM users WHERE id = $1`,
      [req.user.id],
    );
    const { rows: sessions } = await query(
      `SELECT id, ip_address, user_agent, created_at, last_used_at, expires_at, (id = $2) AS current
         FROM sessions WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > NOW()
        ORDER BY last_used_at DESC LIMIT 20`,
      [req.user.id, req.sessionId],
    );
    return successResponse(res, { ...rows[0], sessions, memberships: req.memberships });
  } catch (err) { next(err); }
});

// PATCH /api/v1/users/me
router.patch('/me',
  [
    body('fullName').optional().trim().isLength({ min: 2, max: 255 }),
    body('locale').optional().isIn(['id', 'en']),
    body('timezone').optional().isString().isLength({ max: 50 }),
  ],
  validate,
  async (req, res, next) => {
    try {
      const { fullName, locale, timezone } = req.body;
      if (timezone) {
        try { new Intl.DateTimeFormat('en', { timeZone: timezone }); } catch { throw new AppError('Unknown timezone.', 422); }
      }
      const { rows } = await query(
        `UPDATE users SET full_name = COALESCE($2, full_name), locale = COALESCE($3, locale), timezone = COALESCE($4, timezone)
         WHERE id = $1 RETURNING id, email, full_name, locale, timezone`,
        [req.user.id, fullName, locale, timezone],
      );
      await audit(req, { action: 'user.profile_updated', resourceType: 'user', resourceId: req.user.id, newValues: { fullName, locale, timezone } });
      return successResponse(res, rows[0]);
    } catch (err) { next(err); }
  },
);

export default router;
