import './config/env.js';
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';
import { existsSync } from 'fs';
import { resolve } from 'path';

import { config } from './config/env.js';
import { query } from './config/database.js';
import { errorHandler } from './middleware/errorHandler.js';
import { notFound } from './middleware/notFound.js';
import { requestLogger } from './middleware/requestLogger.js';

import authRoutes from './modules/auth/auth.routes.js';
import userRoutes from './modules/users/user.routes.js';
import orgRoutes from './modules/tenants/org.routes.js';
import portfolioRoutes from './modules/stocks/portfolio.routes.js';
import instrumentRoutes from './modules/stocks/instrument.routes.js';
import transactionRoutes from './modules/stocks/transaction.routes.js';
import watchlistRoutes from './modules/stocks/watchlist.routes.js';
import priceRoutes from './modules/stocks/price.routes.js';
import franchiseRoutes from './modules/franchise/franchise.routes.js';
import brandRoutes from './modules/franchise/brand.routes.js';
import regionRoutes from './modules/franchise/region.routes.js';
import outletRoutes from './modules/franchise/outlet.routes.js';
import salesRoutes from './modules/franchise/sales.routes.js';
import expenseRoutes from './modules/franchise/expense.routes.js';
import inventoryRoutes from './modules/franchise/inventory.routes.js';
import productRoutes from './modules/franchise/product.routes.js';
import targetRoutes from './modules/franchise/target.routes.js';
import importRoutes from './modules/imports/import.routes.js';
import exportRoutes from './modules/reports/export.routes.js';
import reportRoutes from './modules/reports/report.routes.js';
import auditRoutes from './modules/audit/audit.routes.js';
import approvalRoutes from './modules/approvals/approval.routes.js';
import adminRoutes from './modules/admin/admin.routes.js';
import integrationRoutes from './modules/integrations/integration.routes.js';

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  if (process.env.TRUST_PROXY) app.set('trust proxy', process.env.TRUST_PROXY);

  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        frameAncestors: ["'none'"],
        objectSrc: ["'none'"],
      },
    },
    crossOriginEmbedderPolicy: false,
  }));

  app.use(cors({
    origin: config.clientOrigin.split(',').map((s) => s.trim()),
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-CSRF-Token'],
    exposedHeaders: ['Content-Disposition'],
  }));

  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: false, limit: '1mb' }));
  app.use(cookieParser());
  app.use(requestLogger);

  app.use('/api/', rateLimit({
    windowMs: 15 * 60 * 1000,
    max: config.isTest ? 100000 : parseInt(process.env.API_RATE_LIMIT || '1000', 10),
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, message: 'Too many requests, please try again later.' },
  }));

  // ── Health checks ──────────────────────────────────────────────────────────
  const health = async (_req, res) => {
    let database = 'ok';
    try { await query('SELECT 1'); } catch { database = 'unavailable'; }
    res.status(database === 'ok' ? 200 : 503).json({
      status: database === 'ok' ? 'ok' : 'degraded',
      database,
      timestamp: new Date().toISOString(),
      env: config.env,
      demoMode: config.demoMode,
      marketDataProvider: config.marketData.provider,
    });
  };
  app.get('/health', health);
  app.get('/api/v1/health', health);

  const API = '/api/v1';
  app.use(`${API}/auth`, authRoutes);
  app.use(`${API}/users`, userRoutes);
  app.use(`${API}/organisations`, orgRoutes);

  app.use(`${API}/portfolios`, portfolioRoutes);
  app.use(`${API}/instruments`, instrumentRoutes);
  app.use(`${API}/transactions`, transactionRoutes);
  app.use(`${API}/watchlists`, watchlistRoutes);
  app.use(`${API}/prices`, priceRoutes);

  app.use(`${API}/franchise`, franchiseRoutes);
  app.use(`${API}/brands`, brandRoutes);
  app.use(`${API}/regions`, regionRoutes);
  app.use(`${API}/outlets`, outletRoutes);
  app.use(`${API}/sales`, salesRoutes);
  app.use(`${API}/expenses`, expenseRoutes);
  app.use(`${API}/inventory`, inventoryRoutes);
  app.use(`${API}/products`, productRoutes);
  app.use(`${API}/targets`, targetRoutes);

  app.use(`${API}/imports`, importRoutes);
  app.use(`${API}/exports`, exportRoutes);
  app.use(`${API}/reports`, reportRoutes);
  app.use(`${API}/audit`, auditRoutes);
  app.use(`${API}/approvals`, approvalRoutes);
  app.use(`${API}/admin`, adminRoutes);
  app.use(`${API}/integrations`, integrationRoutes);

  app.use('/api', notFound);

  // Optional: serve the built frontend from the same origin (npm run build && npm start).
  const dist = resolve(config.root, 'client/dist');
  if (existsSync(dist) && process.env.SERVE_CLIENT !== 'false') {
    app.use(express.static(dist, { index: 'index.html', maxAge: config.isProd ? '1h' : 0 }));
    app.get(/^(?!\/api).*/, (_req, res) => res.sendFile(resolve(dist, 'index.html')));
  }

  app.use(notFound);
  app.use(errorHandler);
  return app;
}

export default createApp;
