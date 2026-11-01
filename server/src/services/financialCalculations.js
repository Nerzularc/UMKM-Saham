import Decimal from 'decimal.js';

// Configure Decimal.js for financial calculations
Decimal.set({ precision: 28, rounding: Decimal.ROUND_HALF_UP });

/**
 * All monetary operations use Decimal.js to avoid floating-point errors.
 *
 * Cost-basis methods:
 *   WAC  — Weighted Average Cost
 *   FIFO — First In, First Out
 */

// ── Helper ────────────────────────────────────────────────────────────────────
const D = (v) => new Decimal(v ?? 0);
const ZERO = new Decimal(0);

export function toFixed(d, places = 2) {
  return parseFloat(D(d).toFixed(places));
}

export function safeDivide(numerator, denominator, fallback = 0) {
  const denom = D(denominator);
  if (denom.isZero()) return D(fallback);
  return D(numerator).dividedBy(denom);
}

// ── WAC calculations ──────────────────────────────────────────────────────────

/**
 * Calculate a Weighted Average Cost holding state from an ordered list of transactions.
 *
 * @param {Array} transactions  sorted ASC by date
 *   Each: { type, quantity, price, fee, total_amount, exchange_rate, transaction_date }
 * @returns { holdings, realisedPnl, dividends, fees }
 */
export function calcWAC(transactions) {
  let openQty = ZERO;
  let totalCostBasis = ZERO; // in base currency
  let realisedPnl = ZERO;
  let dividends = ZERO;
  let fees = ZERO;
  let totalBought = ZERO;
  const realisedEvents = [];

  for (const tx of transactions) {
    const qty    = D(tx.quantity  ?? 0);
    const price  = D(tx.price     ?? 0);
    const fee    = D(tx.fee       ?? 0);
    const fxRate = D(tx.exchange_rate ?? 1);

    if (tx.transaction_type === 'buy') {
      const costInBase = price.times(qty).times(fxRate).plus(fee.times(fxRate));
      totalCostBasis = totalCostBasis.plus(costInBase);
      totalBought = totalBought.plus(costInBase);
      openQty = openQty.plus(qty);
      fees = fees.plus(fee.times(fxRate));
    } else if (tx.transaction_type === 'sell') {
      const sellQty = qty.greaterThan(openQty) ? openQty : qty;
      const wac = openQty.isZero() ? ZERO : safeDivide(totalCostBasis, openQty);
      const costOfSold = wac.times(sellQty);
      const proceeds = price.times(sellQty).times(fxRate).minus(fee.times(fxRate));
      const gain = proceeds.minus(costOfSold);
      realisedPnl = realisedPnl.plus(gain);
      realisedEvents.push({ date: tx.transaction_date, amount: toFixed(gain, 2) });
      totalCostBasis = totalCostBasis.minus(costOfSold);
      openQty = openQty.minus(qty);
      if (openQty.lessThan(0)) openQty = ZERO;
      if (totalCostBasis.lessThan(0)) totalCostBasis = ZERO;
      fees = fees.plus(fee.times(fxRate));
    } else if (tx.transaction_type === 'dividend') {
      dividends = dividends.plus(D(tx.total_amount).times(fxRate));
    } else if (tx.transaction_type === 'split') {
      // ratio stored in quantity as new_quantity / old_quantity; cost basis unchanged
      if (!qty.isZero()) openQty = openQty.times(qty);
    }
  }

  const wac = openQty.isZero() ? ZERO : safeDivide(totalCostBasis, openQty);

  return {
    openQty: toFixed(openQty, 8),
    totalCostBasis: toFixed(totalCostBasis, 2),
    wac: toFixed(wac, 6),
    realisedPnl: toFixed(realisedPnl, 2),
    dividends: toFixed(dividends, 2),
    fees: toFixed(fees, 2),
    totalBought: toFixed(totalBought, 2),
    realisedEvents,
  };
}

// ── FIFO calculations ─────────────────────────────────────────────────────────

/**
 * Calculate FIFO holding state.
 *
 * @param {Array} transactions sorted ASC by date
 * @returns { lots, openQty, totalCostBasis, realisedPnl, dividends, fees }
 */
export function calcFIFO(transactions) {
  const lots = []; // { qty: Decimal, costPerUnit: Decimal, date }
  let realisedPnl = ZERO;
  let dividends = ZERO;
  let fees = ZERO;
  let totalBought = ZERO;
  const realisedEvents = [];

  for (const tx of transactions) {
    const qty    = D(tx.quantity  ?? 0);
    const price  = D(tx.price     ?? 0);
    const fee    = D(tx.fee       ?? 0);
    const fxRate = D(tx.exchange_rate ?? 1);

    if (tx.transaction_type === 'buy') {
      const costPerUnit = price.times(fxRate).plus(
        qty.isZero() ? ZERO : fee.times(fxRate).dividedBy(qty),
      );
      lots.push({ qty, costPerUnit, date: tx.transaction_date });
      totalBought = totalBought.plus(price.times(qty).times(fxRate).plus(fee.times(fxRate)));
      fees = fees.plus(fee.times(fxRate));
    } else if (tx.transaction_type === 'sell') {
      let remaining = qty;
      const proceedsPerUnit = price.times(fxRate).minus(
        qty.isZero() ? ZERO : fee.times(fxRate).dividedBy(qty),
      );
      fees = fees.plus(fee.times(fxRate));
      let saleGain = ZERO;

      while (remaining.greaterThan(0) && lots.length > 0) {
        const lot = lots[0];
        const used = remaining.greaterThan(lot.qty) ? lot.qty : remaining;
        saleGain = saleGain.plus(proceedsPerUnit.minus(lot.costPerUnit).times(used));
        lot.qty = lot.qty.minus(used);
        remaining = remaining.minus(used);
        if (lot.qty.lte(0)) lots.shift();
      }
      realisedPnl = realisedPnl.plus(saleGain);
      realisedEvents.push({ date: tx.transaction_date, amount: toFixed(saleGain, 2) });
    } else if (tx.transaction_type === 'dividend') {
      dividends = dividends.plus(D(tx.total_amount).times(fxRate));
    } else if (tx.transaction_type === 'split') {
      if (!qty.isZero()) {
        lots.forEach((l) => {
          l.costPerUnit = l.costPerUnit.dividedBy(qty);
          l.qty = l.qty.times(qty);
        });
      }
    }
  }

  const openQty = lots.reduce((acc, l) => acc.plus(l.qty), ZERO);
  const totalCostBasis = lots.reduce((acc, l) => acc.plus(l.qty.times(l.costPerUnit)), ZERO);

  return {
    openQty: toFixed(openQty, 8),
    totalCostBasis: toFixed(totalCostBasis, 2),
    wac: toFixed(openQty.isZero() ? ZERO : safeDivide(totalCostBasis, openQty), 6),
    realisedPnl: toFixed(realisedPnl, 2),
    dividends: toFixed(dividends, 2),
    fees: toFixed(fees, 2),
    totalBought: toFixed(totalBought, 2),
    realisedEvents,
    lots: lots.map((l) => ({ qty: toFixed(l.qty, 8), costPerUnit: toFixed(l.costPerUnit, 6), date: l.date })),
  };
}

// ── Portfolio-level aggregation ───────────────────────────────────────────────

/**
 * Compute holding metrics given cost-basis state and current price.
 *
 * @param {object} holding   Result from calcWAC or calcFIFO
 * @param {number} currentPrice  In portfolio base currency
 */
export function calcHoldingMetrics(holding, currentPrice) {
  const openQty  = D(holding.openQty);
  const costBasis = D(holding.totalCostBasis);
  const price    = D(currentPrice ?? 0);

  const marketValue     = openQty.times(price);
  const unrealisedPnl   = marketValue.minus(costBasis);
  const unrealisedPct   = costBasis.isZero()
    ? null
    : safeDivide(unrealisedPnl, costBasis).times(100);
  const totalReturn     = D(holding.realisedPnl).plus(unrealisedPnl).plus(D(holding.dividends));
  // Return % is measured against all capital ever deployed into the position
  // (cost of every purchase incl. fees), so fully closed positions still have a %.
  const invested        = D(holding.totalBought ?? holding.totalCostBasis);
  const totalReturnPct  = invested.isZero()
    ? null
    : safeDivide(totalReturn, invested).times(100);

  return {
    openQty:       toFixed(openQty, 8),
    costBasis:     toFixed(costBasis, 2),
    currentPrice:  toFixed(price, 6),
    marketValue:   toFixed(marketValue, 2),
    unrealisedPnl: toFixed(unrealisedPnl, 2),
    unrealisedPct: unrealisedPct !== null ? toFixed(unrealisedPct, 2) : null,
    realisedPnl:   toFixed(D(holding.realisedPnl), 2),
    dividends:     toFixed(D(holding.dividends), 2),
    fees:          toFixed(D(holding.fees), 2),
    totalReturn:   toFixed(totalReturn, 2),
    totalReturnPct: totalReturnPct !== null ? toFixed(totalReturnPct, 2) : null,
    investedCapital: toFixed(invested, 2),
    wac:           holding.wac,
  };
}

// ── Cash and performance measures ─────────────────────────────────────────────

/**
 * Cash effect of one transaction in portfolio base currency.
 * deposit +, withdrawal −, buy −(qty×price+fee), sell +(qty×price−fee),
 * dividend +(net amount received), fee −, split 0.
 */
export function cashEffect(tx) {
  const fx = D(tx.exchange_rate ?? 1);
  const qty = D(tx.quantity ?? 0);
  const price = D(tx.price ?? 0);
  const fee = D(tx.fee ?? 0);
  const amount = D(tx.total_amount ?? 0);
  switch (tx.transaction_type) {
    case 'deposit':    return amount.times(fx);
    case 'withdrawal': return amount.times(fx).negated();
    case 'buy':        return price.times(qty).plus(fee).times(fx).negated();
    case 'sell':       return price.times(qty).minus(fee).times(fx);
    case 'dividend':   return amount.times(fx);
    case 'fee':        return amount.times(fx).negated();
    default:           return ZERO;
  }
}

/**
 * Time-weighted return from a daily series.
 * series: [{ value, flow }] where `flow` is the net external contribution on that
 * day (positive = money in), assumed to arrive at the end of the day.
 *   r_t = (V_t − F_t) / V_{t−1} − 1, chained geometrically.
 * Days whose starting value is zero are skipped (no capital at risk).
 * Returns a percentage, or null if there is no measurable period.
 */
export function calcTWR(series) {
  let growth = new Decimal(1);
  let measured = false;
  for (let i = 1; i < series.length; i++) {
    const prev = D(series[i - 1].value);
    if (prev.lte(0)) continue;
    const r = D(series[i].value).minus(D(series[i].flow)).dividedBy(prev);
    growth = growth.times(r);
    measured = true;
  }
  return measured ? toFixed(growth.minus(1).times(100), 4) : null;
}

/**
 * Money-weighted return (annualised IRR / XIRR) by bisection.
 * flows: [{ date: 'YYYY-MM-DD', amount }] from the investor's perspective
 * (contributions negative, withdrawals and the ending value positive).
 * Returns an annualised percentage or null when it cannot be determined.
 */
export function calcXIRR(flows) {
  const clean = flows.filter((f) => f.amount && Number(f.amount) !== 0);
  if (clean.length < 2) return null;
  const hasNeg = clean.some((f) => Number(f.amount) < 0);
  const hasPos = clean.some((f) => Number(f.amount) > 0);
  if (!hasNeg || !hasPos) return null;
  const t0 = new Date(`${clean[0].date}T00:00:00Z`).getTime();
  const years = clean.map((f) => (new Date(`${f.date}T00:00:00Z`).getTime() - t0) / (365 * 86400000));
  if (years[years.length - 1] <= 0) return null;
  const npv = (rate) => clean.reduce((s, f, i) => s + Number(f.amount) / Math.pow(1 + rate, years[i]), 0);

  let lo = -0.9999, hi = 100;
  let fLo = npv(lo), fHi = npv(hi);
  if (Number.isNaN(fLo) || Number.isNaN(fHi) || fLo * fHi > 0) return null;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    const fMid = npv(mid);
    if (Math.abs(fMid) < 1e-7) { lo = hi = mid; break; }
    if (fLo * fMid < 0) { hi = mid; fHi = fMid; } else { lo = mid; fLo = fMid; }
  }
  return toFixed(((lo + hi) / 2) * 100, 4);
}

// ── Franchise profit calculations ─────────────────────────────────────────────

/**
 * Standard franchise P&L calculation.
 * All inputs in the same currency; division uses safe divide.
 */
export function calcFranchisePnL({
  grossSales,
  discounts,
  returns,
  cogs,
  operatingExpenses,
  nonOperatingExpenses = 0,
  taxes = 0,
}) {
  const gs      = D(grossSales);
  const disc    = D(discounts);
  const ret     = D(returns);
  const cogd    = D(cogs);
  const opEx    = D(operatingExpenses);
  const nonOp   = D(nonOperatingExpenses);
  const tax     = D(taxes);

  const netSales       = gs.minus(disc).minus(ret);
  const grossProfit    = netSales.minus(cogd);
  const grossMargin    = safeDivide(grossProfit, netSales).times(100);
  const operatingProfit = grossProfit.minus(opEx);
  const netProfit      = operatingProfit.minus(nonOp).minus(tax);
  const netMargin      = safeDivide(netProfit, netSales).times(100);

  return {
    grossSales:       toFixed(gs, 2),
    discounts:        toFixed(disc, 2),
    returns:          toFixed(ret, 2),
    netSales:         toFixed(netSales, 2),
    cogs:             toFixed(cogd, 2),
    grossProfit:      toFixed(grossProfit, 2),
    grossMarginPct:   toFixed(grossMargin, 2),
    operatingExpenses: toFixed(opEx, 2),
    operatingProfit:  toFixed(operatingProfit, 2),
    nonOperatingExpenses: toFixed(nonOp, 2),
    taxes:            toFixed(tax, 2),
    netProfit:        toFixed(netProfit, 2),
    netMarginPct:     toFixed(netMargin, 2),
  };
}

/**
 * Target achievement percentage.
 */
export function calcTargetAchievement(actual, target) {
  return toFixed(safeDivide(D(actual), D(target)).times(100), 2);
}

/**
 * Period-over-period growth percentage.
 */
export function calcGrowth(current, previous) {
  const prev = D(previous);
  if (prev.isZero()) return null;
  return toFixed(D(current).minus(prev).dividedBy(prev.abs()).times(100), 2);
}

/**
 * Average transaction value.
 */
export function calcATV(netSales, txCount) {
  return toFixed(safeDivide(D(netSales), D(txCount)), 2);
}
