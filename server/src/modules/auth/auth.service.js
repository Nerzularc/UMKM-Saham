import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { randomBytes, createHash } from 'crypto';
import { randomUUID as uuidv4 } from 'crypto';
import { query } from '../../config/database.js';
import { config } from '../../config/env.js';
import { AppError } from '../../utils/errors.js';
import { logger } from '../../utils/logger.js';
import { auditLog } from '../audit/audit.service.js';
import { loadMemberships } from '../../middleware/auth.js';
import {
  generateSecret, verifyTotp, otpauthUri, encryptSecret, decryptSecret,
} from '../../utils/totp.js';

const SALT_ROUNDS = config.isTest ? 4 : 12;
const MAX_LOGIN_ATTEMPTS = 5;
const LOCK_DURATION_MINUTES = 15;
// A real bcrypt hash of a random string, so unknown e-mails cost the same as known ones.
const DUMMY_HASH = bcrypt.hashSync(randomBytes(16).toString('hex'), SALT_ROUNDS);

export function parseDuration(duration) {
  const match = String(duration).match(/^(\d+)([smhd])$/);
  if (!match) return 7 * 24 * 3600 * 1000;
  const multipliers = { s: 1000, m: 60000, h: 3600000, d: 86400000 };
  return parseInt(match[1], 10) * multipliers[match[2]];
}

export async function isRegistrationEnabled() {
  const { rows } = await query("SELECT value FROM platform_settings WHERE key = 'registration_enabled'");
  return rows.length ? rows[0].value !== false : true;
}

export async function registerUser({ email, password, fullName, locale = 'id' }) {
  if (!(await isRegistrationEnabled())) {
    throw new AppError('Registration is currently disabled.', 403);
  }
  const normalised = email.toLowerCase();
  const existing = await query('SELECT id FROM users WHERE email = $1', [normalised]);
  if (existing.rows.length > 0) {
    throw new AppError('An account with this email already exists.', 409);
  }

  const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
  const { rows } = await query(
    `INSERT INTO users (id, email, password_hash, full_name, locale)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, email, full_name, locale, is_superadmin, created_at`,
    [uuidv4(), normalised, passwordHash, fullName, locale],
  );

  await auditLog({ actorId: rows[0].id, actorEmail: normalised, action: 'auth.register', resourceType: 'user', resourceId: rows[0].id });
  logger.info({ userId: rows[0].id }, 'New user registered');
  return rows[0];
}

/**
 * Verify credentials (and TOTP when enabled) and open a session.
 * Returns { token, csrfToken, user }.
 */
export async function loginUser({ email, password, totpCode, ipAddress, userAgent }) {
  const normalised = String(email).toLowerCase();
  const { rows } = await query(
    `SELECT id, email, password_hash, full_name, is_active, is_superadmin, locale,
            two_factor_enabled, two_factor_secret, login_attempts, locked_until
       FROM users WHERE email = $1 AND deleted_at IS NULL`,
    [normalised],
  );
  const user = rows[0];

  const passwordMatch = await bcrypt.compare(String(password), user?.password_hash || DUMMY_HASH);

  if (user?.locked_until && new Date(user.locked_until) > new Date()) {
    await auditLog({ actorId: user.id, actorEmail: user.email, action: 'auth.login_locked', resourceType: 'user', resourceId: user.id, ipAddress, userAgent });
    throw new AppError('Account temporarily locked due to too many failed attempts.', 423);
  }

  if (!user || !passwordMatch) {
    if (user) await incrementLoginAttempts(user.id);
    await auditLog({
      actorId: user?.id || null, actorEmail: normalised, action: 'auth.login_failed',
      resourceType: 'user', resourceId: user?.id || null, ipAddress, userAgent,
    });
    throw new AppError('Invalid email or password.', 401);
  }

  if (!user.is_active) {
    throw new AppError('This account has been deactivated.', 403);
  }

  if (user.two_factor_enabled) {
    if (!totpCode) {
      const err = new AppError('Two-factor code required.', 401);
      err.code = 'TOTP_REQUIRED';
      throw err;
    }
    const secret = decryptSecret(user.two_factor_secret);
    if (!verifyTotp(secret, totpCode)) {
      await incrementLoginAttempts(user.id);
      await auditLog({ actorId: user.id, actorEmail: user.email, action: 'auth.totp_failed', resourceType: 'user', resourceId: user.id, ipAddress, userAgent });
      const err = new AppError('Invalid two-factor code.', 401);
      err.code = 'TOTP_INVALID';
      throw err;
    }
  }

  await query(
    'UPDATE users SET login_attempts = 0, locked_until = NULL, last_login_at = NOW() WHERE id = $1',
    [user.id],
  );

  const sessionId = uuidv4();
  const token = jwt.sign(
    { sub: user.id, jti: sessionId },
    process.env.JWT_SECRET,
    { expiresIn: config.jwtExpiresIn, algorithm: 'HS256' },
  );
  const expiresAt = new Date(Date.now() + parseDuration(config.jwtExpiresIn));
  const tokenHash = createHash('sha256').update(token).digest('hex');

  await query(
    `INSERT INTO sessions (id, user_id, token_hash, ip_address, user_agent, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [sessionId, user.id, tokenHash, normaliseIp(ipAddress), userAgent || null, expiresAt],
  );

  await auditLog({
    actorId: user.id, actorEmail: user.email, action: 'auth.login',
    resourceType: 'session', resourceId: sessionId, ipAddress, userAgent,
  });

  return {
    token,
    csrfToken: randomBytes(24).toString('hex'),
    expiresAt,
    user: {
      id: user.id,
      email: user.email,
      fullName: user.full_name,
      locale: user.locale,
      isSuperadmin: user.is_superadmin,
      twoFactorEnabled: user.two_factor_enabled,
    },
  };
}

/** Revoke only the current session (other devices stay signed in). */
export async function logoutUser(userId, sessionId) {
  await query('UPDATE sessions SET revoked_at = NOW() WHERE id = $1 AND user_id = $2', [sessionId, userId]);
  await auditLog({ actorId: userId, action: 'auth.logout', resourceType: 'session', resourceId: sessionId });
}

/** Revoke every session of a user (password change, deactivation, "sign out everywhere"). */
export async function revokeAllSessions(userId, actorId = userId) {
  await query('UPDATE sessions SET revoked_at = NOW() WHERE user_id = $1 AND revoked_at IS NULL', [userId]);
  await auditLog({ actorId, action: 'auth.sessions_revoked', resourceType: 'user', resourceId: userId });
}

export async function changePassword(userId, currentPassword, newPassword) {
  const { rows } = await query('SELECT password_hash, email FROM users WHERE id = $1', [userId]);
  if (!rows.length || !(await bcrypt.compare(String(currentPassword), rows[0].password_hash))) {
    throw new AppError('Current password is incorrect.', 400);
  }
  const hash = await bcrypt.hash(newPassword, SALT_ROUNDS);
  await query('UPDATE users SET password_hash = $2 WHERE id = $1', [userId, hash]);
  await auditLog({ actorId: userId, actorEmail: rows[0].email, action: 'auth.password_changed', resourceType: 'user', resourceId: userId });
}

export async function getUserMemberships(userId) {
  return loadMemberships(userId);
}

// ── Two-factor enrolment ─────────────────────────────────────────────────────

export async function beginTwoFactorSetup(user) {
  const secret = generateSecret();
  await query('UPDATE users SET two_factor_pending_secret = $2 WHERE id = $1', [user.id, encryptSecret(secret)]);
  return { secret, otpauthUri: otpauthUri(secret, user.email) };
}

export async function confirmTwoFactor(user, code) {
  const { rows } = await query('SELECT two_factor_pending_secret FROM users WHERE id = $1', [user.id]);
  const pending = rows[0]?.two_factor_pending_secret;
  if (!pending) throw new AppError('Start two-factor setup first.', 400);
  const secret = decryptSecret(pending);
  if (!verifyTotp(secret, code)) throw new AppError('Invalid two-factor code.', 400);
  await query(
    `UPDATE users SET two_factor_enabled = TRUE, two_factor_secret = $2, two_factor_pending_secret = NULL
     WHERE id = $1`,
    [user.id, pending],
  );
  await auditLog({ actorId: user.id, actorEmail: user.email, action: 'auth.2fa_enabled', resourceType: 'user', resourceId: user.id });
}

export async function disableTwoFactor(user, password, code) {
  const { rows } = await query('SELECT password_hash, two_factor_secret FROM users WHERE id = $1', [user.id]);
  const row = rows[0];
  if (!row || !(await bcrypt.compare(String(password || ''), row.password_hash))) {
    throw new AppError('Password is incorrect.', 400);
  }
  if (!row.two_factor_secret || !verifyTotp(decryptSecret(row.two_factor_secret), code)) {
    throw new AppError('Invalid two-factor code.', 400);
  }
  await query(
    'UPDATE users SET two_factor_enabled = FALSE, two_factor_secret = NULL, two_factor_pending_secret = NULL WHERE id = $1',
    [user.id],
  );
  await auditLog({ actorId: user.id, actorEmail: user.email, action: 'auth.2fa_disabled', resourceType: 'user', resourceId: user.id });
}

async function incrementLoginAttempts(userId) {
  await query(
    `UPDATE users SET login_attempts = login_attempts + 1,
       locked_until = CASE WHEN login_attempts + 1 >= $2
         THEN NOW() + ($3 || ' minutes')::interval ELSE locked_until END
     WHERE id = $1`,
    [userId, MAX_LOGIN_ATTEMPTS, String(LOCK_DURATION_MINUTES)],
  );
}

function normaliseIp(ip) {
  if (!ip) return null;
  return ip.startsWith('::ffff:') ? ip.slice(7) : ip;
}
