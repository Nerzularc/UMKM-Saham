import jwt from 'jsonwebtoken';
import { timingSafeEqual } from 'crypto';
import { query } from '../config/database.js';
import { UnauthorizedError, ForbiddenError } from '../utils/errors.js';

export const AUTH_COOKIE = 'token';
export const CSRF_COOKIE = 'csrf_token';
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

/**
 * Load the memberships of a user in active, non-deleted organisations.
 */
export async function loadMemberships(userId) {
  const { rows } = await query(
    `SELECT om.org_id, om.role_id, r.name AS role_name,
            o.name AS org_name, o.slug AS org_slug, o.modules_enabled, o.default_currency,
            o.default_timezone
       FROM org_memberships om
       JOIN organisations o ON o.id = om.org_id AND o.deleted_at IS NULL AND o.is_active = TRUE
       JOIN roles r ON r.id = om.role_id
      WHERE om.user_id = $1 AND om.is_active = TRUE
      ORDER BY o.name`,
    [userId],
  );
  return rows;
}

/**
 * Require a valid, non-revoked session.
 *
 * Browsers authenticate with the HTTP-only `token` cookie. Because cookies are
 * sent automatically, state-changing requests authenticated by cookie must also
 * carry the `X-CSRF-Token` header matching the `csrf_token` cookie
 * (double-submit pattern). API clients may instead send `Authorization: Bearer`,
 * which is not CSRF-exposed.
 */
export async function requireAuth(req, _res, next) {
  try {
    const authHeader = req.headers.authorization;
    const bearer = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
    const cookieToken = req.cookies?.[AUTH_COOKIE];
    const token = bearer || cookieToken;
    if (!token) throw new UnauthorizedError();

    if (!bearer && !SAFE_METHODS.has(req.method)) {
      const header = req.get('X-CSRF-Token');
      if (!safeEqual(header, req.cookies?.[CSRF_COOKIE])) {
        throw new ForbiddenError('Invalid or missing CSRF token.');
      }
    }

    const payload = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'] });

    const { rows } = await query(
      `SELECT u.id, u.email, u.full_name, u.is_superadmin, u.locale, u.timezone,
              u.two_factor_enabled
         FROM sessions s
         JOIN users u ON u.id = s.user_id
        WHERE s.id = $1 AND s.user_id = $2 AND s.revoked_at IS NULL AND s.expires_at > NOW()
          AND u.is_active = TRUE AND u.deleted_at IS NULL`,
      [payload.jti, payload.sub],
    );
    if (!rows.length) throw new UnauthorizedError('Session expired or revoked.');

    const user = rows[0];
    req.user = {
      id: user.id,
      email: user.email,
      fullName: user.full_name,
      isSuperadmin: user.is_superadmin,
      locale: user.locale,
      timezone: user.timezone,
      twoFactorEnabled: user.two_factor_enabled,
    };
    req.sessionId = payload.jti;
    req.memberships = await loadMemberships(user.id);
    req.tokenPayload = payload;

    query('UPDATE sessions SET last_used_at = NOW() WHERE id = $1', [payload.jti]).catch(() => {});
    next();
  } catch (err) {
    if (err.name === 'JsonWebTokenError' || err.name === 'TokenExpiredError' || err.name === 'NotBeforeError') {
      return next(new UnauthorizedError('Invalid or expired token.'));
    }
    next(err);
  }
}

/**
 * Require platform superadmin.
 */
export function requireSuperadmin(req, _res, next) {
  if (!req.user?.isSuperadmin) {
    return next(new ForbiddenError('Superadmin access required.'));
  }
  next();
}
