import express from 'express';
import rateLimit from 'express-rate-limit';
import { body } from 'express-validator';
import { validate } from '../../middleware/validate.js';
import * as authController from './auth.controller.js';
import { requireAuth } from '../../middleware/auth.js';
import { config } from '../../config/env.js';

const router = express.Router();

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: config.isTest ? 1000 : 10,
  message: { success: false, message: 'Too many login attempts, please try again in 15 minutes.' },
  standardHeaders: true,
  legacyHeaders: false,
});

const sensitiveLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: config.isTest ? 1000 : 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many requests, please try again later.' },
});

const strongPassword = (field) => body(field)
  .isLength({ min: 8, max: 128 }).withMessage('Password must be 8–128 characters.')
  .matches(/[A-Za-z]/).withMessage('Password must contain a letter.')
  .matches(/\d/).withMessage('Password must contain a number.');

router.post('/register',
  sensitiveLimiter,
  [
    body('email').isEmail().normalizeEmail({ gmail_remove_dots: false }).isLength({ max: 320 }),
    strongPassword('password'),
    body('fullName').trim().isLength({ min: 2, max: 255 }).withMessage('Full name is required.'),
    body('locale').optional().isIn(['id', 'en']),
  ],
  validate,
  authController.register,
);

router.post('/login',
  loginLimiter,
  [
    body('email').isEmail().normalizeEmail({ gmail_remove_dots: false }),
    body('password').isString().notEmpty().withMessage('Password is required.'),
    body('totp').optional().isString().isLength({ min: 6, max: 6 }),
  ],
  validate,
  authController.login,
);

router.post('/logout', requireAuth, authController.logout);
router.post('/logout-all', requireAuth, authController.logoutAll);
router.get('/me', requireAuth, authController.me);

// GET /api/v1/auth/session — like /me but answers 200 with user=null when signed out,
// so the SPA can check for a session without producing an error.
router.get('/session', (req, res, next) => {
  if (!req.cookies?.token && !req.headers.authorization) return res.json({ success: true, data: { user: null } });
  return requireAuth(req, res, (err) => {
    if (err && err.status === 401) return res.json({ success: true, data: { user: null } });
    if (err) return next(err);
    return authController.me(req, res, next);
  });
});

router.post('/password',
  requireAuth, sensitiveLimiter,
  [body('currentPassword').isString().notEmpty(), strongPassword('newPassword')],
  validate,
  authController.changePassword,
);

router.post('/2fa/setup', requireAuth, sensitiveLimiter, authController.twoFactorSetup);
router.post('/2fa/enable', requireAuth, sensitiveLimiter, [body('code').isString().isLength({ min: 6, max: 6 })], validate, authController.twoFactorEnable);
router.post('/2fa/disable', requireAuth, sensitiveLimiter, [body('code').isString(), body('password').isString()], validate, authController.twoFactorDisable);

export default router;
