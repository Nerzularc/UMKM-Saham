/**
 * Portfolio service: access control, holdings, cash and performance analytics.
 *
 * Holdings are always recomputed from the transaction ledger (no stored
 * positions), so every view — holdings, charts, exports — uses one set of rules.
 * See docs/formulas.md for the accounting conventions.
 */
import Decimal from 'decimal.js';
import { query } from '../../config/database.js';
import { AppError, NotFoundError, ForbiddenError } from '../../utils/errors.js';
import {
  calcWAC, calcFIFO, calcHoldingMetrics, cashEffect, calcTWR, calcXIRR, toFixed,
} from '../../services/financialCalculations.js';
import { isUuid, roleHas, PERMISSIONS as P } from '../../services/permissions.js';
import { todayIn, addDays, daysBetween } from '../../utils/dates.js';
import { randomUUID as uuidv4 } from 'crypto';

const STALE_MS = 24 * 3600 * 1000;

// ── Access ────────────────────────────────────────────────────────────────────

/**
 * Personal portfolios: only the creator.
 * Organisation portfolios: the creator, plus organisation owners (manage) and
 * managers (read-only) of that organisation.
 */
export async function getPortfolio(portfolioId, req, { write = false } = {}) {
  if (!isUuid(portfolioId)) throw new NotFoundError('Portfolio');
  const { rows } = await query('SELECT * FROM portfolios WHERE id = $1 AND deleted_at IS NULL', [portfolioId]);
  const p = rows[0];
  if (!p) throw new NotFoundError('Portfolio');
  if (p.user_id === req.user.id) return p;
  if (p.org_id) {
    const m = req.memberships.find((x) => x.org_id === p.org_id);
    if (m && roleHas(m.role_name, P.ORG_MANAGE)) return p;
    if (m && !write && roleHas(m.role_name, P.FINANCIALS_READ)) return p;
    if (m) throw new ForbiddenError('You do not have permission to modify this portfolio.');
  }
  throw new NotFoundError('Portfolio');
}

export async function listPortfolios(req, orgId = null) {
  const params = [req.user.id];
  let where = 'p.user_id = $1 AND p.org_id IS NULL';
  if (orgId) {
    const m = req.memberships.find((x) => x.org_id === orgId);
    if (!m) throw new ForbiddenError('You do not have access to this organisation.');
    params.push(orgId);
    where = roleHas(m.role_name, P.FINANCIALS_READ)
      ? 'p.org_id = $2'
      : 'p.org_id = $2 AND p.user_id = $1';
  }
  const { rows } = await query(
    `SELECT p.*, COUNT(pt.id)::int AS transaction_count
       FROM portfolios p
       LEFT JOIN portfolio_transactions pt ON pt.portfolio_id = p.id AND pt.deleted_at IS NULL
      WHERE ${where} AND p.deleted_at IS NULL
      GROUP BY p.id
      ORDER BY p.is_default DESC, p.created_at ASC`,
    params,
  );
  return rows;
}

export async function createPortfolio(data, req) {
  const { name, description, baseCurrency = 'IDR', costBasisMethod = 'WAC', orgId = null, portfolioType = 'tracking' } = data;
  if (orgId) {
    const m = req.memberships.find((x) => x.org_id === orgId);
    if (!m || !roleHas(m.role_name, P.ORG_MANAGE)) throw new ForbiddenError('Only organisation owners can create organisation portfolios.');
    if (!(m.modules_enabled || []).includes('stocks')) throw new ForbiddenError('The stocks module is not enabled for this organisation.');
  }
  const existing = await query('SELECT 1 FROM portfolios WHERE user_id = $1 AND deleted_at IS NULL LIMIT 1', [req.user.id]);
  const { rows } = await query(
    `INSERT INTO portfolios (id, user_id, org_id, name, description, base_currency, cost_basis_method, is_default, portfolio_type)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [uuidv4(), req.user.id, orgId, name, description || null, baseCurrency.toUpperCase(),
      costBasisMethod.toUpperCase(), existing.rows.length === 0, portfolioType],
  );
  return rows[0];
}

// ── Market data helpers ───────────────────────────────────────────────────────

/** Latest rate from → to on or before `date` (or latest overall). Tries the inverse pair. */
export async function getExchangeRate(from, to, date = null) {
  if (from === to) return { rate: '1', date: null, isDemo: false };
  const { rows } = await query(
    `SELECT from_currency, rate, rate_date, is_demo FROM exchange_rates
      WHERE ((from_currency = $1 AND to_currency = $2) OR (from_currency = $2 AND to_currency = $1))
        AND ($3::date IS NULL OR rate_date <= $3)
      ORDER BY rate_date DESC, (from_currency = $1) DESC LIMIT 1`,
    [from, to, date],
  );
  if (!rows.length) return null;
  const r = rows[0];
  const rate = r.from_currency === from ? new Decimal(r.rate) : new Decimal(1).dividedBy(r.rate);
  return { rate: rate.toString(), date: r.rate_date, isDemo: r.is_demo };
}

async function loadTransactions(portfolioId) {
  const { rows } = await query(
    `SELECT pt.*, i.symbol, i.name AS instrument_name, i.currency AS instrument_currency, i.sector,
            i.last_price, i.last_price_at, i.price_source, i.is_demo AS price_is_demo,
            e.code AS exchange_code, e.country AS market_country
       FROM portfolio_transactions pt
       LEFT JOIN instruments i ON i.id = pt.instrument_id
       LEFT JOIN exchanges e ON e.id = i.exchange_id
      WHERE pt.portfolio_id = $1 AND pt.deleted_at IS NULL
      ORDER BY pt.transaction_date ASC, pt.created_at ASC`,
    [portfolioId],
  );
  return rows;
}

function costState(method, txns) {
  return method === 'FIFO' ? calcFIFO(txns) : calcWAC(txns);
}

/** Open quantity of an instrument on a date, optionally excluding one transaction. */
export async function openQuantityAt(portfolioId, instrumentId, date, excludeId = null) {
  const { rows } = await query(
    `SELECT transaction_type, quantity FROM portfolio_transactions
      WHERE portfolio_id = $1 AND instrument_id = $2 AND deleted_at IS NULL
        AND transaction_date <= $3 AND ($4::uuid IS NULL OR id <> $4)
      ORDER BY transaction_date, created_at`,
    [portfolioId, instrumentId, date, excludeId],
  );
  let q = new Decimal(0);
  for (const r of rows) {
    if (r.transaction_type === 'buy') q = q.plus(r.quantity);
    else if (r.transaction_type === 'sell') q = q.minus(r.quantity);
    else if (r.transaction_type === 'split') q = q.times(r.quantity);
  }
  return q;
}

// ── Holdings ──────────────────────────────────────────────────────────────────

export async function getPortfolioHoldings(portfolioId, req) {
  const portfolio = await getPortfolio(portfolioId, req);
  const txns = await loadTransactions(portfolioId);
  const base = portfolio.base_currency;

  const byInstrument = new Map();
  let cash = new Decimal(0);
  let accountFees = new Decimal(0);
  let deposits = new Decimal(0);
  let withdrawals = new Decimal(0);
  for (const tx of txns) {
    cash = cash.plus(cashEffect(tx));
    if (tx.transaction_type === 'fee') accountFees = accountFees.plus(new Decimal(tx.total_amount).times(tx.exchange_rate ?? 1));
    if (tx.transaction_type === 'deposit') deposits = deposits.plus(new Decimal(tx.total_amount).times(tx.exchange_rate ?? 1));
    if (tx.transaction_type === 'withdrawal') withdrawals = withdrawals.plus(new Decimal(tx.total_amount).times(tx.exchange_rate ?? 1));
    if (!tx.instrument_id) continue;
    if (!byInstrument.has(tx.instrument_id)) {
      byInstrument.set(tx.instrument_id, {
        instrumentId: tx.instrument_id, symbol: tx.symbol, name: tx.instrument_name,
        currency: tx.instrument_currency, exchangeCode: tx.exchange_code, sector: tx.sector,
        lastPrice: tx.last_price, lastPriceAt: tx.last_price_at, priceSource: tx.price_source,
        priceIsDemo: tx.price_is_demo, transactions: [],
      });
    }
    byInstrument.get(tx.instrument_id).transactions.push(tx);
  }

  const holdings = [];
  const warnings = [];
  for (const data of byInstrument.values()) {
    const state = costState(portfolio.cost_basis_method, data.transactions);
    let priceInBase = null;
    let fx = null;
    if (data.lastPrice != null) {
      fx = await getExchangeRate(data.currency, base);
      if (fx) priceInBase = new Decimal(data.lastPrice).times(fx.rate).toString();
      else warnings.push(`No ${data.currency}/${base} exchange rate: ${data.symbol} cannot be valued in ${base}.`);
    } else {
      warnings.push(`No price available for ${data.symbol}.`);
    }
    const valued = priceInBase != null;
    const metrics = calcHoldingMetrics(state, valued ? priceInBase : 0);
    if (!valued) Object.assign(metrics, { marketValue: null, unrealisedPnl: null, unrealisedPct: null, totalReturn: null, totalReturnPct: null });

    const { transactions, ...meta } = data;
    holdings.push({
      ...meta,
      ...metrics,
      realisedEvents: state.realisedEvents,
      lots: state.lots,
      costBasisMethod: portfolio.cost_basis_method,
      valued,
      priceInBase: valued ? toFixed(priceInBase, 6) : null,
      fxRate: fx?.rate ? toFixed(fx.rate, 8) : null,
      fxRateDate: fx?.date || null,
      priceStale: data.lastPriceAt ? Date.now() - new Date(data.lastPriceAt).getTime() > STALE_MS : true,
      isOpen: Number(metrics.openQty) > 0,
    });
  }

  const open = holdings.filter((h) => h.isOpen);
  const allValued = open.every((h) => h.valued);
  const sum = (arr, k) => arr.reduce((s, h) => s.plus(h[k] ?? 0), new Decimal(0));
  const marketValue = sum(open, 'marketValue');
  const costBasis = sum(open, 'costBasis');
  const realised = sum(holdings, 'realisedPnl');
  const dividends = sum(holdings, 'dividends');
  const tradingFees = sum(holdings, 'fees');
  const unrealised = sum(open.filter((h) => h.valued), 'unrealisedPnl');
  const invested = sum(holdings, 'investedCapital');
  // Trading fees are already inside cost basis / sale proceeds. Only standalone
  // account fees (transaction_type = 'fee') are subtracted here — no double counting.
  const totalReturn = realised.plus(unrealised).plus(dividends).minus(accountFees);
  const usesCash = !deposits.isZero() || !withdrawals.isZero();

  const allocation = (key) => {
    const groups = new Map();
    for (const h of open.filter((x) => x.valued)) {
      const k = h[key] || 'Unclassified';
      groups.set(k, (groups.get(k) || new Decimal(0)).plus(h.marketValue));
    }
    return [...groups.entries()].map(([label, v]) => ({
      label, value: toFixed(v, 2), pct: marketValue.isZero() ? 0 : toFixed(v.dividedBy(marketValue).times(100), 2),
    })).sort((a, b) => b.value - a.value);
  };

  const anyDemo = holdings.some((h) => h.priceIsDemo);
  return {
    portfolio,
    holdings: holdings.sort((a, b) => (b.marketValue ?? -1) - (a.marketValue ?? -1)),
    summary: {
      baseCurrency: base,
      costBasisMethod: portfolio.cost_basis_method,
      portfolioType: portfolio.portfolio_type,
      marketValue: toFixed(marketValue, 2),
      costBasis: toFixed(costBasis, 2),
      unrealisedPnl: toFixed(unrealised, 2),
      unrealisedPct: costBasis.isZero() ? null : toFixed(unrealised.dividedBy(costBasis).times(100), 2),
      realisedPnl: toFixed(realised, 2),
      dividends: toFixed(dividends, 2),
      tradingFees: toFixed(tradingFees, 2),
      accountFees: toFixed(accountFees, 2),
      totalReturn: toFixed(totalReturn, 2),
      totalReturnPct: invested.isZero() ? null : toFixed(totalReturn.dividedBy(invested).times(100), 2),
      investedCapital: toFixed(invested, 2),
      cashTracking: usesCash,
      cashBalance: usesCash ? toFixed(cash, 2) : null,
      netDeposits: usesCash ? toFixed(deposits.minus(withdrawals), 2) : null,
      totalValue: usesCash ? toFixed(marketValue.plus(cash), 2) : toFixed(marketValue, 2),
      openPositions: open.length,
      complete: allValued,
      pricesAreDemo: anyDemo,
      priceDisclaimer: anyDemo ? 'Includes DEMONSTRATION prices — not real market data.' : null,
    },
    allocation: {
      byInstrument: open.filter((h) => h.valued).map((h) => ({
        label: h.symbol, value: h.marketValue, pct: marketValue.isZero() ? 0 : toFixed(new Decimal(h.marketValue).dividedBy(marketValue).times(100), 2),
      })),
      byExchange: allocation('exchangeCode'),
      bySector: allocation('sector'),
      byCurrency: allocation('currency'),
    },
    warnings,
  };
}

// ── Performance (time series, TWR, MWR) ───────────────────────────────────────

function sampleDates(from, to, maxPoints = 370) {
  const total = daysBetween(from, to) + 1;
  const step = Math.max(1, Math.ceil(total / maxPoints));
  const dates = [];
  for (let d = from; d <= to; d = addDays(d, step)) dates.push(d);
  if (dates[dates.length - 1] !== to) dates.push(to);
  return dates;
}

/**
 * Daily (or sampled) valuation series with TWR and MWR.
 *
 * Valuation price for each instrument on date d = latest close from
 * price_observations on/before d; if none exists yet, the latest trade price
 * recorded in the portfolio on/before d. FX uses the latest rate on/before d.
 *
 * External flows:
 *  - cash-tracking portfolios (have deposits/withdrawals): deposits and withdrawals;
 *    value = positions + cash.
 *  - holdings-only portfolios: purchases are contributions; sale proceeds and
 *    dividends are distributions; value = positions only.
 */
export async function getPortfolioPerformance(portfolioId, req, { from, to } = {}) {
  const portfolio = await getPortfolio(portfolioId, req);
  const txns = await loadTransactions(portfolioId);
  const base = portfolio.base_currency;
  const today = todayIn();
  if (!txns.length) {
    return { portfolio: { id: portfolio.id, name: portfolio.name }, series: [], twrPct: null, mwrPct: null, notes: ['NO_TRANSACTIONS'] };
  }

  const firstDate = txns[0].transaction_date;
  const start = from && from > firstDate ? from : firstDate;
  const end = to && to < today ? to : today;
  if (start > end) throw new AppError('Invalid period.', 400);

  const usesCash = txns.some((t) => t.transaction_type === 'deposit' || t.transaction_type === 'withdrawal');
  const instrumentIds = [...new Set(txns.filter((t) => t.instrument_id).map((t) => t.instrument_id))];
  const currencies = [...new Set(txns.filter((t) => t.instrument_id).map((t) => t.instrument_currency))].filter((c) => c !== base);

  const [{ rows: prices }, { rows: rates }] = await Promise.all([
    instrumentIds.length
      ? query(
        `SELECT instrument_id, price_date, close_price, is_demo FROM price_observations
          WHERE instrument_id = ANY($1::uuid[]) AND price_date <= $2 ORDER BY price_date`,
        [instrumentIds, end],
      )
      : { rows: [] },
    currencies.length
      ? query(
        `SELECT from_currency, to_currency, rate, rate_date FROM exchange_rates
          WHERE ((from_currency = ANY($1::text[]) AND to_currency = $2) OR (to_currency = ANY($1::text[]) AND from_currency = $2))
            AND rate_date <= $3 ORDER BY rate_date`,
        [currencies, base, end],
      )
      : { rows: [] },
  ]);

  const priceSeries = new Map(instrumentIds.map((id) => [id, []]));
  for (const p of prices) priceSeries.get(p.instrument_id).push(p);
  const fxSeries = new Map(currencies.map((c) => [c, []]));
  for (const r of rates) {
    if (r.to_currency === base) fxSeries.get(r.from_currency).push({ date: r.rate_date, rate: new Decimal(r.rate) });
    else fxSeries.get(r.to_currency).push({ date: r.rate_date, rate: new Decimal(1).dividedBy(r.rate) });
  }
  for (const s of fxSeries.values()) s.sort((a, b) => a.date.localeCompare(b.date));

  const lastOnOrBefore = (arr, date, key = 'date') => {
    let lo = 0, hi = arr.length - 1, ans = null;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (arr[mid][key] <= date) { ans = arr[mid]; lo = mid + 1; } else hi = mid - 1;
    }
    return ans;
  };

  const dates = sampleDates(start, end);
  const notes = [];
  let fxApproximated = false;
  let priceFromTrades = false;
  const series = [];
  let ti = 0;
  const qty = new Map();
  const tradePrice = new Map();
  let cash = new Decimal(0);
  let pendingFlow = new Decimal(0);
  const flowsForMwr = [];

  // Apply transactions before the start date silently (opening position).
  for (const date of dates) {
    while (ti < txns.length && txns[ti].transaction_date <= date) {
      const tx = txns[ti++];
      const fx = new Decimal(tx.exchange_rate ?? 1);
      cash = cash.plus(cashEffect(tx));
      if (tx.instrument_id) {
        const q = qty.get(tx.instrument_id) || new Decimal(0);
        if (tx.transaction_type === 'buy') qty.set(tx.instrument_id, q.plus(tx.quantity));
        if (tx.transaction_type === 'sell') qty.set(tx.instrument_id, Decimal.max(0, q.minus(tx.quantity)));
        if (tx.transaction_type === 'split') qty.set(tx.instrument_id, q.times(tx.quantity));
        if (tx.price != null && (tx.transaction_type === 'buy' || tx.transaction_type === 'sell')) {
          tradePrice.set(tx.instrument_id, { date: tx.transaction_date, price: new Decimal(tx.price) });
        }
      }
      let flow = new Decimal(0);
      if (usesCash) {
        if (tx.transaction_type === 'deposit') flow = new Decimal(tx.total_amount).times(fx);
        if (tx.transaction_type === 'withdrawal') flow = new Decimal(tx.total_amount).times(fx).negated();
      } else {
        // holdings-only: purchases are contributions, proceeds/dividends distributions
        if (['buy', 'sell', 'dividend', 'fee'].includes(tx.transaction_type)) flow = cashEffect(tx).negated();
      }
      // Flows before the period are represented by the opening value instead.
      if (!flow.isZero() && tx.transaction_date >= start) {
        pendingFlow = pendingFlow.plus(flow);
        flowsForMwr.push({ date: tx.transaction_date, amount: flow.negated().toNumber() });
      }
    }

    let positions = new Decimal(0);
    let complete = true;
    for (const [id, q] of qty) {
      if (q.isZero()) continue;
      const obs = lastOnOrBefore(priceSeries.get(id), date, 'price_date');
      const trade = tradePrice.get(id);
      let px = null;
      if (obs && (!trade || obs.price_date >= trade.date)) px = new Decimal(obs.close_price);
      else if (trade) { px = trade.price; priceFromTrades = true; }
      if (!px) { complete = false; continue; }
      const cur = txns.find((t) => t.instrument_id === id).instrument_currency;
      let rate = new Decimal(1);
      if (cur !== base) {
        const fxs = fxSeries.get(cur) || [];
        const r = lastOnOrBefore(fxs, date) || fxs[0];
        if (!r) { complete = false; continue; }
        if (r.date > date) fxApproximated = true;
        rate = r.rate;
      }
      positions = positions.plus(q.times(px).times(rate));
    }
    const value = usesCash ? positions.plus(cash) : positions;
    series.push({
      date,
      value: toFixed(value, 2),
      positions: toFixed(positions, 2),
      cash: usesCash ? toFixed(cash, 2) : null,
      flow: toFixed(pendingFlow, 2),
      complete,
    });
    pendingFlow = new Decimal(0);
  }

  const last = series[series.length - 1];
  // Opening value counts as a contribution on the start date for MWR.
  const opening = series[0];
  const mwrFlows = [];
  if (Number(opening.value) - Number(opening.flow) > 0 && txns[0].transaction_date < start) {
    mwrFlows.push({ date: start, amount: -(Number(opening.value) - Number(opening.flow)) });
  }
  mwrFlows.push(...flowsForMwr);
  mwrFlows.push({ date: end, amount: Number(last.value) });
  mwrFlows.sort((a, b) => a.date.localeCompare(b.date));

  if (priceFromTrades) notes.push('PRICE_FROM_TRADES');
  if (fxApproximated) notes.push('FX_APPROXIMATED');
  if (series.some((s) => !s.complete)) notes.push('INCOMPLETE_POINTS');
  if (!usesCash) notes.push('HOLDINGS_MODE');
  if (dates.length < daysBetween(start, end) + 1) notes.push('SAMPLED');

  const { rows: demoRows } = instrumentIds.length
    ? await query('SELECT bool_or(is_demo) AS any FROM price_observations WHERE instrument_id = ANY($1::uuid[])', [instrumentIds])
    : { rows: [{ any: false }] };

  // Monthly dividends and realised P/L (base currency)
  const dividendsByMonth = {};
  for (const t of txns) {
    if (t.transaction_type === 'dividend') {
      const m = t.transaction_date.slice(0, 7);
      dividendsByMonth[m] = (dividendsByMonth[m] || 0) + Number(new Decimal(t.total_amount).times(t.exchange_rate ?? 1));
    }
  }

  // notes are machine-readable codes; the client translates them (see docs/formulas.md)
  return {
    portfolio: { id: portfolio.id, name: portfolio.name, baseCurrency: base },
    period: { from: start, to: end },
    mode: usesCash ? 'cash' : 'holdings',
    series,
    twrPct: calcTWR(series),
    mwrPct: calcXIRR(mwrFlows),
    mwrAnnualised: true,
    dividendsByMonth: Object.entries(dividendsByMonth).sort().map(([month, amount]) => ({ month, amount: toFixed(amount, 2) })),
    pricesAreDemo: demoRows[0]?.any === true,
    notes,
  };
}
