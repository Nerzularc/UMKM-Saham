import { validationResult } from 'express-validator';
import { ValidationError } from '../utils/errors.js';

/**
 * Middleware that checks express-validator results and throws a ValidationError if any.
 */
export function validate(req, _res, next) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return next(new ValidationError(errors.array().map(e => ({
      field: e.path,
      message: e.msg,
    }))));
  }
  next();
}
