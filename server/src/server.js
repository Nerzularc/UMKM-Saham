import './config/env.js';
import { createApp } from './app.js';
import { config } from './config/env.js';
import { logger } from './utils/logger.js';
import { startJobs } from './jobs/scheduler.js';

const app = createApp();

const server = app.listen(config.port, () => {
  logger.info(`API listening on http://localhost:${config.port} [${config.env}]`);
  logger.info(`Health check: http://localhost:${config.port}/api/v1/health`);
  if (config.demoMode) {
    logger.info('DEMO MODE — seeded prices and records are demonstration data, not real market data.');
  }
  if (config.jobsEnabled) startJobs();
});

function shutdown(signal) {
  logger.info(`${signal} received, shutting down.`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
