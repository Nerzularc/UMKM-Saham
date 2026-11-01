import Decimal from 'decimal.js';
import { AppError } from '../../utils/errors.js';
import { randomUUID as uuidv4 } from 'crypto';

export const INBOUND = new Set(['receive', 'transfer_in']);
export const OUTBOUND = new Set(['issue', 'sale', 'waste', 'transfer_out']);
export const MOVEMENT_TYPES = [...INBOUND, ...OUTBOUND, 'adjustment'];

/** Signed balance change for a movement. Adjustments carry their own sign. */
export function signedQuantity(type, quantity) {
  const q = new Decimal(quantity);
  if (INBOUND.has(type)) return q.abs();
  if (OUTBOUND.has(type)) return q.abs().negated();
  if (type === 'adjustment') return q;
  throw new AppError(`Unknown movement type "${type}".`, 422);
}

/**
 * Record a stock movement and update the balance atomically (caller supplies the
 * transaction client). Rejects movements that would make stock negative.
 * Returns { movement, balance } or { duplicate: true } when sourceHash already exists.
 */
export async function applyMovement(client, m) {
  const delta = signedQuantity(m.movementType, m.quantity);
  if (delta.isZero()) throw new AppError('Quantity must not be zero.', 422);
  if (m.movementType !== 'adjustment' && new Decimal(m.quantity).lte(0)) {
    throw new AppError('Quantity must be greater than zero.', 422);
  }

  await client.query(
    `INSERT INTO inventory_balances (id, outlet_id, product_id, quantity) VALUES ($1,$2,$3,0)
     ON CONFLICT (outlet_id, product_id) DO NOTHING`,
    [uuidv4(), m.outletId, m.productId],
  );
  const { rows: bal } = await client.query(
    'SELECT quantity FROM inventory_balances WHERE outlet_id = $1 AND product_id = $2 FOR UPDATE',
    [m.outletId, m.productId],
  );
  const next = new Decimal(bal[0].quantity).plus(delta);
  if (next.lt(0)) {
    throw new AppError(`Insufficient stock: available ${bal[0].quantity}, requested ${delta.abs().toString()}.`, 422);
  }

  const unitCost = m.unitCost == null || m.unitCost === '' ? null : new Decimal(m.unitCost);
  const { rows } = await client.query(
    `INSERT INTO inventory_movements
       (id, outlet_id, product_id, movement_type, quantity, unit_cost, total_cost, reference_type,
        reference_id, notes, moved_by, movement_date, source_hash, transfer_id, import_batch_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
     ON CONFLICT DO NOTHING
     RETURNING *`,
    [uuidv4(), m.outletId, m.productId, m.movementType, delta.toString(),
      unitCost?.toString() ?? null, unitCost ? unitCost.times(delta.abs()).toFixed(2) : null,
      m.referenceType || null, m.referenceId || null, m.notes || null, m.userId,
      m.movementDate, m.sourceHash || null, m.transferId || null, m.importBatchId || null],
  );
  if (!rows.length) return { duplicate: true };

  await client.query(
    'UPDATE inventory_balances SET quantity = $3, updated_at = NOW() WHERE outlet_id = $1 AND product_id = $2',
    [m.outletId, m.productId, next.toString()],
  );
  return { movement: rows[0], balance: next.toString() };
}
