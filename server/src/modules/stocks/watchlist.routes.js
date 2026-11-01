import express from 'express';
import { body } from 'express-validator';
import { validate } from '../../middleware/validate.js';
import { requireAuth } from '../../middleware/auth.js';
import { query } from '../../config/database.js';
import { successResponse, createdResponse } from '../../utils/response.js';
import { NotFoundError, AppError } from '../../utils/errors.js';
import { isUuid } from '../../services/permissions.js';
import { audit } from '../audit/audit.service.js';
import { randomUUID as uuidv4 } from 'crypto';

const router = express.Router();
router.use(requireAuth);

async function ownWatchlist(req, id) {
  if (!isUuid(id)) throw new NotFoundError('Watchlist');
  const { rows } = await query('SELECT * FROM watchlists WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL', [id, req.user.id]);
  if (!rows.length) throw new NotFoundError('Watchlist');
  return rows[0];
}

router.get('/', async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT w.*, COUNT(wi.id)::int AS item_count
         FROM watchlists w LEFT JOIN watchlist_items wi ON wi.watchlist_id = w.id
        WHERE w.user_id = $1 AND w.deleted_at IS NULL
        GROUP BY w.id ORDER BY w.created_at ASC`,
      [req.user.id],
    );
    return successResponse(res, rows);
  } catch (err) { next(err); }
});

router.post('/', [body('name').trim().isLength({ min: 1, max: 255 })], validate, async (req, res, next) => {
  try {
    const { rows } = await query(
      'INSERT INTO watchlists (id, user_id, name, description) VALUES ($1,$2,$3,$4) RETURNING *',
      [uuidv4(), req.user.id, req.body.name, req.body.description || null],
    );
    return createdResponse(res, rows[0]);
  } catch (err) { next(err); }
});

router.delete('/:id', async (req, res, next) => {
  try {
    const w = await ownWatchlist(req, req.params.id);
    await query('UPDATE watchlists SET deleted_at = NOW() WHERE id = $1', [w.id]);
    await audit(req, { action: 'watchlist.delete', resourceType: 'watchlist', resourceId: w.id });
    return res.status(204).send();
  } catch (err) { next(err); }
});

router.get('/:id/items', async (req, res, next) => {
  try {
    const w = await ownWatchlist(req, req.params.id);
    const { rows } = await query(
      `SELECT wi.*, i.symbol, i.name AS instrument_name, i.currency, i.sector, i.last_price, i.last_price_at,
              i.price_source, i.is_demo, e.code AS exchange_code,
              (i.last_price_at IS NULL OR i.last_price_at < NOW() - INTERVAL '24 hours') AS price_stale,
              (SELECT close_price FROM price_observations po WHERE po.instrument_id = i.id
                 AND po.price_date < COALESCE(i.last_price_at::date, CURRENT_DATE)
                ORDER BY po.price_date DESC LIMIT 1) AS previous_close
         FROM watchlist_items wi
         JOIN instruments i ON i.id = wi.instrument_id
         JOIN exchanges e ON e.id = i.exchange_id
        WHERE wi.watchlist_id = $1 ORDER BY i.symbol`,
      [w.id],
    );
    return successResponse(res, rows);
  } catch (err) { next(err); }
});

router.post('/:id/items', [body('instrumentId').isUUID()], validate, async (req, res, next) => {
  try {
    const w = await ownWatchlist(req, req.params.id);
    const { rows: inst } = await query('SELECT id FROM instruments WHERE id = $1 AND is_active = TRUE', [req.body.instrumentId]);
    if (!inst.length) throw new AppError('Unsupported instrument.', 422);
    await query(
      'INSERT INTO watchlist_items (id, watchlist_id, instrument_id, notes) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING',
      [uuidv4(), w.id, req.body.instrumentId, req.body.notes || null],
    );
    return createdResponse(res, { watchlistId: w.id, instrumentId: req.body.instrumentId });
  } catch (err) { next(err); }
});

router.delete('/:id/items/:instrumentId', async (req, res, next) => {
  try {
    const w = await ownWatchlist(req, req.params.id);
    if (!isUuid(req.params.instrumentId)) throw new NotFoundError('Item');
    await query('DELETE FROM watchlist_items WHERE watchlist_id = $1 AND instrument_id = $2', [w.id, req.params.instrumentId]);
    return res.status(204).send();
  } catch (err) { next(err); }
});

export default router;
