/**
 * Validation and normalisation of portfolio transactions (shared by manual
 * entry, editing and file imports).
 */
import Decimal from 'decimal.js';
import { query } from '../../config/database.js';
import { AppError } from '../../utils/errors.js';
import { isUuid } from '../../services/permissions.js';
import { isIsoDate, todayIn } from '../../utils/dates.js';
import { getExchangeRate, openQuantityAt } from './portfolio.service.js';

export const TRANSACTION_TYPES = ['buy', 'sell', 'dividend', 'deposit', 'withdrawal', 'fee', 'split'];
const NEEDS_INSTRUMENT = new Set(['buy', 'sell', 'dividend', 'split']);

function dec(value, field, { positive = false, nonNegative = false } = {}) {
  if (value === undefined || value === null || value === '') return null;
  let d;
  try { d = new Decimal(String(value).trim()); } catch { throw new AppError(`${field} must be a number.`, 422); }
  if (!d.isFinite()) throw new AppError(`${field} must be a number.`, 422);
  if (positive && d.lte(0)) throw new AppError(`${field} must be greater than zero.`, 422);
  if (nonNegative && d.lt(0)) throw new AppError(`${field} cannot be negative.`, 422);
  return d;
}

/**
 * @returns normalised row ready for INSERT/UPDATE (strings for NUMERIC columns)
 */
export async function prepareTransaction(portfolio, input, { excludeId = null, skipHoldingCheck = false } = {}) {
  const type = String(input.transactionType || '').toLowerCase();
  if (!TRANSACTION_TYPES.includes(type)) throw new AppError(`Unsupported transaction type "${input.transactionType}".`, 422);
  const date = input.transactionDate;
  if (!isIsoDate(date)) throw new AppError('transactionDate must be YYYY-MM-DD.', 422);
  if (date > todayIn()) throw new AppError('Transaction date cannot be in the future.', 422);

  let instrument = null;
  if (NEEDS_INSTRUMENT.has(type)) {
    if (!isUuid(input.instrumentId)) throw new AppError('A valid instrument is required for this transaction type.', 422);
    const { rows } = await query(
      'SELECT id, symbol, currency, is_active FROM instruments WHERE id = $1', [input.instrumentId],
    );
    if (!rows.length || !rows[0].is_active) throw new AppError('Unsupported or inactive instrument.', 422);
    instrument = rows[0];
  } else if (input.instrumentId) {
    throw new AppError(`${type} transactions must not reference an instrument.`, 422);
  }

  const quantity = dec(input.quantity, 'quantity', { positive: ['buy', 'sell', 'split'].includes(type) });
  const price = dec(input.price, 'price', { nonNegative: true });
  const fee = dec(input.fee ?? 0, 'fee', { nonNegative: true }) || new Decimal(0);
  let total = dec(input.totalAmount, 'totalAmount', { nonNegative: true });

  let currency = String(input.currency || instrument?.currency || portfolio.base_currency).toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) throw new AppError('currency must be a 3-letter ISO code.', 422);
  if (instrument && currency !== instrument.currency) {
    throw new AppError(`${instrument.symbol} trades in ${instrument.currency}; record the transaction in that currency.`, 422);
  }

  if (type === 'buy' || type === 'sell') {
    if (!quantity) throw new AppError('quantity is required.', 422);
    if (price === null) throw new AppError('price is required.', 422);
    total = price.times(quantity); // gross trade value, fees kept separately
  } else if (type === 'split') {
    if (!quantity) throw new AppError('Split ratio (quantity) is required, e.g. 2 for a 2-for-1 split.', 422);
    total = new Decimal(0);
  } else {
    if (!total || total.lte(0)) throw new AppError('totalAmount must be greater than zero.', 422);
  }

  if (type === 'sell' && !skipHoldingCheck) {
    const open = await openQuantityAt(portfolio.id, instrument.id, date, excludeId);
    if (quantity.gt(open)) {
      throw new AppError(`Cannot sell ${quantity} ${instrument.symbol}: only ${open} held on ${date}.`, 422);
    }
  }

  // Exchange rate to the portfolio base currency
  let rate = dec(input.exchangeRate, 'exchangeRate', { positive: true });
  if (currency === portfolio.base_currency) {
    rate = new Decimal(1);
  } else if (!rate) {
    const fx = await getExchangeRate(currency, portfolio.base_currency, date);
    if (!fx) {
      throw new AppError(`No ${currency}/${portfolio.base_currency} rate available on ${date}. Provide exchangeRate explicitly.`, 422);
    }
    rate = new Decimal(fx.rate);
  }

  const baseAmount = total.times(rate);
  return {
    instrument_id: instrument?.id || null,
    transaction_type: type,
    transaction_date: date,
    transaction_time: input.transactionTime || null,
    quantity: quantity ? quantity.toString() : null,
    price: price ? price.toString() : null,
    total_amount: total.toFixed(2),
    fee: fee.toFixed(2),
    currency,
    exchange_rate: rate.toString(),
    base_amount: baseAmount.toFixed(2),
    notes: input.notes ? String(input.notes).slice(0, 2000) : null,
    reference: input.reference ? String(input.reference).slice(0, 255) : null,
    is_simulated: portfolio.portfolio_type === 'simulation',
  };
}
