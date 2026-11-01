import express from 'express';
import { body } from 'express-validator';
import { validate } from '../../middleware/validate.js';
import { requireAuth } from '../../middleware/auth.js';
import { query } from '../../config/database.js';
import { successResponse, createdResponse } from '../../utils/response.js';
import { AppError, NotFoundError } from '../../utils/errors.js';
import { audit } from '../audit/audit.service.js';
import { pagination, sortClause } from '../../utils/pagination.js';
import { isUuid } from '../../services/permissions.js';
import { isIsoDate } from '../../utils/dates.js';
import { getPortfolio, openQuantityAt } from './portfolio.service.js';
import { prepareTransaction, TRANSACTION_TYPES } from './transaction.service.js';
import { randomUUID as uuidv4 } from 'crypto';

const router = express.Router();
router.use(requireAuth);

const COLUMNS = ['instrument_id', 'transaction_type', 'transaction_date', 'transaction_time', 'quantity', 'price',
  'total_amount', 'fee', 'currency', 'exchange_rate', 'base_amount', 'notes', 'reference', 'is_simulated'];

/**
 * Transactions visible to the caller: optionally restricted to one portfolio
 * (which must pass the portfolio access check).
 */
export async function transactionWhere(req) {
  const { portfolioId, type, from, to, instrumentId } = req.query;
  const params = [];
  let where;
  if (portfolioId) {
    const p = await getPortfolio(portfolioId, req);
    params.push(p.id);
    where = 'pt.portfolio_id = $1';
  } else {
    params.push(req.user.id);
    where = 'p.user_id = $1';
  }
  where += ' AND pt.deleted_at IS NULL AND p.deleted_at IS NULL';
  if (type && TRANSACTION_TYPES.includes(type)) { params.push(type); where += ` AND pt.transaction_type = $${params.length}`; }
  if (instrumentId && isUuid(instrumentId)) { params.push(instrumentId); where += ` AND pt.instrument_id = $${params.length}`; }
  if (from) { if (!isIsoDate(from)) throw new AppError('Invalid from date.', 400); params.push(from); where += ` AND pt.transaction_date >= $${params.length}`; }
  if (to)   { if (!isIsoDate(to)) throw new AppError('Invalid to date.', 400); params.push(to); where += ` AND pt.transaction_date <= $${params.length}`; }
  return { where, params };
}

// GET /api/v1/transactions?portfolioId=&type=&from=&to=&page=&limit=&sort=&order=
router.get('/', async (req, res, next) => {
  try {
    const { where, params } = await transactionWhere(req);
    const { page, limit, offset } = pagination(req.query);
    const order = sortClause(req.query, { date: 'pt.transaction_date', amount: 'pt.base_amount', symbol: 'i.symbol', type: 'pt.transaction_type' }, 'pt.transaction_date DESC, pt.created_at DESC');
    const [{ rows }, { rows: cr }] = await Promise.all([
      query(
        `SELECT pt.*, p.name AS portfolio_name, p.portfolio_type, p.base_currency,
                i.symbol, i.name AS instrument_name, e.code AS exchange_code
           FROM portfolio_transactions pt
           JOIN portfolios p ON p.id = pt.portfolio_id
           LEFT JOIN instruments i ON i.id = pt.instrument_id
           LEFT JOIN exchanges e ON e.id = i.exchange_id
          WHERE ${where} ${order}
          LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, limit, offset],
      ),
      query(`SELECT COUNT(*) FROM portfolio_transactions pt JOIN portfolios p ON p.id = pt.portfolio_id LEFT JOIN instruments i ON i.id = pt.instrument_id WHERE ${where}`, params),
    ]);
    const total = parseInt(cr[0].count, 10);
    return res.json({ success: true, data: rows, meta: { total, page, limit, totalPages: Math.ceil(total / limit) } });
  } catch (err) { next(err); }
});

const txValidators = [
  body('transactionType').isIn(TRANSACTION_TYPES),
  body('transactionDate').isISO8601({ strict: true }),
  body('quantity').optional({ values: 'null' }).isFloat({ min: 0 }),
  body('price').optional({ values: 'null' }).isFloat({ min: 0 }),
  body('fee').optional({ values: 'null' }).isFloat({ min: 0 }),
  body('totalAmount').optional({ values: 'null' }).isFloat({ min: 0 }),
  body('exchangeRate').optional({ values: 'null' }).isFloat({ gt: 0 }),
  body('currency').optional().isLength({ min: 3, max: 3 }),
  body('instrumentId').optional({ values: 'null' }).isUUID(),
  body('notes').optional({ values: 'null' }).isString().isLength({ max: 2000 }),
];

// POST /api/v1/transactions
router.post('/', [body('portfolioId').isUUID(), ...txValidators], validate, async (req, res, next) => {
  try {
    const portfolio = await getPortfolio(req.body.portfolioId, req, { write: true });
    const row = await prepareTransaction(portfolio, req.body);
    const id = uuidv4();
    const { rows } = await query(
      `INSERT INTO portfolio_transactions (id, portfolio_id, ${COLUMNS.join(', ')})
       VALUES ($1, $2, ${COLUMNS.map((_, i) => `$${i + 3}`).join(', ')}) RETURNING *`,
      [id, portfolio.id, ...COLUMNS.map((c) => row[c])],
    );
    await audit(req, { orgId: portfolio.org_id, action: 'transaction.create', resourceType: 'portfolio_transaction', resourceId: id, newValues: rows[0] });
    return createdResponse(res, rows[0]);
  } catch (err) { next(err); }
});

async function loadTx(req, id, write) {
  if (!isUuid(id)) throw new NotFoundError('Transaction');
  const { rows } = await query('SELECT * FROM portfolio_transactions WHERE id = $1 AND deleted_at IS NULL', [id]);
  if (!rows.length) throw new NotFoundError('Transaction');
  const portfolio = await getPortfolio(rows[0].portfolio_id, req, { write });
  return { tx: rows[0], portfolio };
}

/** After removing/changing a buy or split, no later sale may exceed the holding. */
async function assertLedgerConsistent(portfolioId, instrumentId) {
  if (!instrumentId) return;
  const { rows } = await query(
    `SELECT transaction_date FROM portfolio_transactions
      WHERE portfolio_id = $1 AND instrument_id = $2 AND transaction_type = 'sell' AND deleted_at IS NULL
      ORDER BY transaction_date`, [portfolioId, instrumentId],
  );
  for (const r of rows) {
    const q = await openQuantityAt(portfolioId, instrumentId, r.transaction_date);
    if (q.lt(0)) throw new AppError('This change would leave a later sale without enough shares.', 422);
  }
}

// PUT /api/v1/transactions/:id — corrections require a reason and are fully audited
router.put('/:id', [...txValidators, body('reason').isString().isLength({ min: 3, max: 1000 }).withMessage('A reason is required for corrections.')], validate, async (req, res, next) => {
  try {
    const { tx, portfolio } = await loadTx(req, req.params.id, true);
    const row = await prepareTransaction(portfolio, req.body, { excludeId: tx.id });
    const set = COLUMNS.map((c, i) => `${c} = $${i + 2}`).join(', ');
    const { rows } = await query(`UPDATE portfolio_transactions SET ${set} WHERE id = $1 RETURNING *`, [tx.id, ...COLUMNS.map((c) => row[c])]);
    try {
      await assertLedgerConsistent(portfolio.id, tx.instrument_id);
    } catch (e) {
      // Revert: the correction would leave a later sale uncovered.
      await query(`UPDATE portfolio_transactions SET ${set} WHERE id = $1`, [tx.id, ...COLUMNS.map((c) => tx[c])]);
      throw e;
    }
    await audit(req, { orgId: portfolio.org_id, action: 'transaction.update', resourceType: 'portfolio_transaction', resourceId: tx.id, oldValues: tx, newValues: rows[0], metadata: { reason: req.body.reason } });
    return successResponse(res, rows[0]);
  } catch (err) { next(err); }
});

// DELETE /api/v1/transactions/:id (soft delete, audited)
router.delete('/:id', async (req, res, next) => {
  try {
    const { tx, portfolio } = await loadTx(req, req.params.id, true);
    await query('UPDATE portfolio_transactions SET deleted_at = NOW() WHERE id = $1', [tx.id]);
    try {
      await assertLedgerConsistent(portfolio.id, tx.instrument_id);
    } catch (e) {
      await query('UPDATE portfolio_transactions SET deleted_at = NULL WHERE id = $1', [tx.id]);
      throw e;
    }
    await audit(req, { orgId: portfolio.org_id, action: 'transaction.delete', resourceType: 'portfolio_transaction', resourceId: tx.id, oldValues: tx, metadata: { reason: req.body?.reason || req.query.reason || null } });
    return res.status(204).send();
  } catch (err) { next(err); }
});

export default router;
