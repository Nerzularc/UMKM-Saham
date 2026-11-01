import * as authService from './auth.service.js';
import { successResponse, createdResponse } from '../../utils/response.js';
import { AUTH_COOKIE, CSRF_COOKIE } from '../../middleware/auth.js';
import { config } from '../../config/env.js';

function cookieOptions(expiresAt, httpOnly) {
  return {
    httpOnly,
    secure: config.isProd,
    sameSite: 'lax',
    path: '/',
    expires: expiresAt,
  };
}

export async function register(req, res, next) {
  try {
    const user = await authService.registerUser(req.body);
    return createdResponse(res, user, 'Account created successfully.');
  } catch (err) { next(err); }
}

export async function login(req, res, next) {
  try {
    const { token, csrfToken, expiresAt, user } = await authService.loginUser({
      email: req.body.email,
      password: req.body.password,
      totpCode: req.body.totp,
      ipAddress: req.ip,
      userAgent: req.get('User-Agent'),
    });

    // The session token lives only in an HTTP-only cookie; it is never returned to JavaScript.
    res.cookie(AUTH_COOKIE, token, cookieOptions(expiresAt, true));
    // The CSRF token is readable by the SPA and echoed back in X-CSRF-Token.
    res.cookie(CSRF_COOKIE, csrfToken, cookieOptions(expiresAt, false));

    const memberships = await authService.getUserMemberships(user.id);
    return successResponse(res, { user: { ...user, memberships } }, { message: 'Login successful.' });
  } catch (err) {
    if (err.code === 'TOTP_REQUIRED' || err.code === 'TOTP_INVALID') {
      return res.status(401).json({ success: false, message: err.message, code: err.code });
    }
    next(err);
  }
}

export async function logout(req, res, next) {
  try {
    await authService.logoutUser(req.user.id, req.sessionId);
    res.clearCookie(AUTH_COOKIE, { path: '/' });
    res.clearCookie(CSRF_COOKIE, { path: '/' });
    return successResponse(res, null, { message: 'Logged out successfully.' });
  } catch (err) { next(err); }
}

export async function logoutAll(req, res, next) {
  try {
    await authService.revokeAllSessions(req.user.id);
    res.clearCookie(AUTH_COOKIE, { path: '/' });
    res.clearCookie(CSRF_COOKIE, { path: '/' });
    return successResponse(res, null, { message: 'All sessions signed out.' });
  } catch (err) { next(err); }
}

export async function me(req, res, next) {
  try {
    return successResponse(res, { user: { ...req.user, memberships: req.memberships } });
  } catch (err) { next(err); }
}

export async function changePassword(req, res, next) {
  try {
    await authService.changePassword(req.user.id, req.body.currentPassword, req.body.newPassword);
    await authService.revokeAllSessions(req.user.id);
    res.clearCookie(AUTH_COOKIE, { path: '/' });
    res.clearCookie(CSRF_COOKIE, { path: '/' });
    return successResponse(res, null, { message: 'Password changed. Please sign in again.' });
  } catch (err) { next(err); }
}

export async function twoFactorSetup(req, res, next) {
  try {
    return successResponse(res, await authService.beginTwoFactorSetup(req.user));
  } catch (err) { next(err); }
}

export async function twoFactorEnable(req, res, next) {
  try {
    await authService.confirmTwoFactor(req.user, req.body.code);
    return successResponse(res, { enabled: true });
  } catch (err) { next(err); }
}

export async function twoFactorDisable(req, res, next) {
  try {
    await authService.disableTwoFactor(req.user, req.body.password, req.body.code);
    return successResponse(res, { enabled: false });
  } catch (err) { next(err); }
}
