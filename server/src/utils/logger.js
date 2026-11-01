import '../config/env.js';
import pino from 'pino';

const env = process.env.NODE_ENV || 'development';
const pretty = env === 'development';

export const logger = pino({
  level: env === 'test' ? (process.env.LOG_LEVEL_TEST || 'silent') : (process.env.LOG_LEVEL || 'info'),
  transport: pretty
    ? { target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:standard' } }
    : undefined,
  // Never write credentials or session material to logs.
  redact: {
    paths: [
      'req.headers.authorization', 'req.headers.cookie', 'req.headers["x-csrf-token"]',
      'password', '*.password', 'token', '*.token', 'secret', '*.secret',
      'apiKey', '*.apiKey', 'two_factor_secret', '*.two_factor_secret',
    ],
    censor: '[REDACTED]',
  },
  serializers: {
    err: pino.stdSerializers.err,
    req: (req) => ({ method: req.method, url: req.url, id: req.id }),
    res: pino.stdSerializers.res,
  },
});
