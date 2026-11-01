import { logger } from '../utils/logger.js';

/**
 * Centralised error handler.
 * Internal details (stack traces, SQL, driver messages) are logged, never returned.
 */
export function errorHandler(err, req, res, _next) {
  let status = err.status || err.statusCode || 500;

  if (err.type === 'validation') {
    return res.status(422).json({ success: false, message: 'Validation failed', errors: err.errors });
  }
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ success: false, message: 'Malformed JSON body.' });
  }
  if (err.type === 'entity.too.large' || err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ success: false, message: 'Payload too large.' });
  }
  if (err.name === 'JsonWebTokenError' || err.name === 'TokenExpiredError') {
    return res.status(401).json({ success: false, message: 'Invalid or expired token' });
  }

  // PostgreSQL error codes → client-safe responses
  switch (err.code) {
    case '23505': return res.status(409).json({ success: false, message: 'A record with that value already exists.' });
    case '23503': return res.status(400).json({ success: false, message: 'Referenced record does not exist.' });
    case '23514': return res.status(422).json({ success: false, message: 'Value violates a data-integrity rule.' });
    case '22P02': return res.status(400).json({ success: false, message: 'Invalid identifier or value format.' });
    case '22003': return res.status(422).json({ success: false, message: 'Numeric value out of range.' });
    case '22007':
    case '22008': return res.status(422).json({ success: false, message: 'Invalid date value.' });
    default: break;
  }

  if (status >= 500) {
    logger.error({ err, req }, `Error ${status}: ${err.message}`);
    status = 500;
  } else {
    logger.debug({ status, msg: err.message, url: req.originalUrl }, 'Client error');
  }

  res.status(status).json({
    success: false,
    message: status < 500 ? err.message : 'An unexpected error occurred.',
    ...(err.errors && status < 500 ? { errors: err.errors } : {}),
  });
}
