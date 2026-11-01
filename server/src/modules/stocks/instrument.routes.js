import express from 'express';
import { body } from 'express-validator';
import { validate } from '../../middleware/validate.js';
import { requireAuth, requireSuperadmin } from '../../middleware/auth.js';
import { query } from '../../config/database.js';
import { successResponse, createdResponse } from '../../utils/response.js';
import { NotFoundError, AppError } from '../../utils/errors.js';
import { isUuid } from '../../services/permissions.js';
import { pagination } from '../../utils/pagination.js';
import { isIsoDate } from '../../utils/dates.js';
import { audit } from '../audit/audit.service.js';
import { randomUUID as uuidv4 } from 'crypto';

const router = express.Router();
router.use(requireAuth);

// GET /api/v1/instruments/exchanges
router.get('/exchanges', async (_req, res, next) => {
  try {
    const { rows } = await query('SELECT id, code, name, country, currency, timezone FROM exchanges WHERE is_active = TRUE ORDER BY code');
    return successResponse(res, rows);
  } catch (err) { next(err); }
});

// GET /api/v1/instruments?q=&exchange=&page=&limit=
router.get('/', async (req, res, next) => {
  try {
    const { q, exchange } = req.query;
    const { page, limit, offset } = pagination(req.query, { defaultLimit: 20, maxLimit: 200 });
    const params = [];
    let where = 'WHERE i.is_active = TRUE';
    if (q) { params.push(`%${String(q).slice(0, 50)}%`); where += ` AND (i.symbol ILIKE $${params.length} OR i.name ILIKE $${params.length})`; }
    if (exchange) { params.push(String(exchange).toUpperCase()); where += ` AND e.code = $${params.length}`; }
    const { rows } = await query(
      `SELECT i.id, i.symbol, i.name, i.asset_type, i.currency, i.sector, i.last_price, i.last_price_at,
              i.price_source, i.is_demo, e.code AS exchange_code, e.name AS exchange_name, e.country,
              (i.last_price_at IS NULL OR i.last_price_at < NOW() - INTERVAL '24 hours') AS price_stale
         FROM instruments i JOIN exchanges e ON e.id = i.exchange_id
        ${where} ORDER BY i.symbol LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset],
    );
    return successResponse(res, rows);
  } catch (err) { next(err); }
});

// POST /api/v1/instruments — superadmin maintains the instrument catalogue
router.post('/',
  requireSuperadmin,
  [body('exchangeCode').isString(), body('symbol').trim().isLength({ min: 1, max: 20 }), body('name').trim().isLength({ min: 1, max: 255 }),
    body('currency').isLength({ min: 3, max: 3 }), body('providerSymbol').optional().isLength({ max: 50 })],
  validate,
  async (req, res, next) => {
    try {
      const { exchangeCode, symbol, name, currency, sector, assetType = 'stock', providerSymbol } = req.body;
      const { rows: ex } = await query('SELECT id FROM exchanges WHERE code = $1', [String(exchangeCode).toUpperCase()]);
      if (!ex.length) throw new AppError('Unknown exchange.', 422);
      const { rows } = await query(
        `INSERT INTO instruments (id, exchange_id, symbol, name, currency, sector, asset_type, provider_symbol)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
        [uuidv4(), ex[0].id, symbol.toUpperCase(), name, currency.toUpperCase(), sector || null, assetType, providerSymbol || null],
      );
      await audit(req, { action: 'instrument.create', resourceType: 'instrument', resourceId: rows[0].id, newValues: rows[0] });
      return createdResponse(res, rows[0]);
    } catch (err) { next(err); }
  },
);

// GET /api/v1/instruments/:id
router.get('/:id', async (req, res, next) => {
  try {
    if (!isUuid(req.params.id)) throw new NotFoundError('Instrument');
    const { rows } = await query(
      `SELECT i.*, e.code AS exchange_code, e.name AS exchange_name, e.timezone AS exchange_timezone
         FROM instruments i JOIN exchanges e ON e.id = i.exchange_id WHERE i.id = $1`,
      [req.params.id],
    );
    if (!rows.length) throw new NotFoundError('Instrument');
    return successResponse(res, rows[0]);
  } catch (err) { next(err); }
});

// GET /api/v1/instruments/:id/prices?from=&to=
router.get('/:id/prices', async (req, res, next) => {
  try {
    if (!isUuid(req.params.id)) throw new NotFoundError('Instrument');
    const { from, to } = req.query;
    const limit = Math.min(parseInt(req.query.limit, 10) || 365, 2000);
    const params = [req.params.id];
    let where = '';
    if (from) { if (!isIsoDate(from)) throw new AppError('Invalid from date.', 400); params.push(from); where += ` AND price_date >= $${params.length}`; }
    if (to)   { if (!isIsoDate(to)) throw new AppError('Invalid to date.', 400); params.push(to); where += ` AND price_date <= $${params.length}`; }
    params.push(limit);
    const { rows } = await query(
      `SELECT price_date, open_price, high_price, low_price, close_price, volume, is_demo, source
         FROM price_observations WHERE instrument_id = $1 ${where}
        ORDER BY price_date DESC LIMIT $${params.length}`,
      params,
    );
    return successResponse(res, rows.reverse(), { meta: { isDemo: rows.some((r) => r.is_demo) } });
  } catch (err) { next(err); }
});

export default router;
