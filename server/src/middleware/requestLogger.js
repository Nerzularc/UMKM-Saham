import { logger } from '../utils/logger.js';

export function requestLogger(req, _res, next) {
  const start = Date.now();
  _res.on('finish', () => {
    const ms = Date.now() - start;
    logger.info({
      method: req.method,
      url: req.url,
      status: _res.statusCode,
      ms,
      ip: req.ip,
      user: req.user?.id,
    }, `${req.method} ${req.url} ${_res.statusCode} ${ms}ms`);
  });
  next();
}
