import express from 'express';
import { requireAuth } from '../../middleware/auth.js';
import { query } from '../../config/database.js';
import { successResponse } from '../../utils/response.js';

const router = express.Router();
router.use(requireAuth);

// GET /api/v1/prices/latest?symbols=BBCA,AAPL
router.get('/latest', async (req, res, next) => {
  try {
    const symList = String(req.query.symbols || '').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean).slice(0, 100);
    if (!symList.length) return successResponse(res, []);
    const { rows } = await query(
      `SELECT i.id, i.symbol, i.last_price, i.last_price_at, i.price_source, i.is_demo, i.currency, e.code AS exchange_code,
              (i.last_price_at IS NULL OR i.last_price_at < NOW() - INTERVAL '24 hours') AS price_stale
         FROM instruments i JOIN exchanges e ON e.id = i.exchange_id
        WHERE i.symbol = ANY($1::text[])`,
      [symList],
    );
    return successResponse(res, rows);
  } catch (err) { next(err); }
});

export default router;
