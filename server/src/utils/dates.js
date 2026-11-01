import { AppError } from './errors.js';
import { config } from '../config/env.js';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Today's calendar date (YYYY-MM-DD) in the given IANA timezone. */
export function todayIn(timezone = config.timezone) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

export function isIsoDate(value) {
  if (typeof value !== 'string' || !DATE_RE.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

export function addDays(iso, days) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function daysBetween(fromIso, toIso) {
  return Math.round((new Date(`${toIso}T00:00:00Z`) - new Date(`${fromIso}T00:00:00Z`)) / 86400000);
}

export function monthStart(iso) {
  return `${iso.slice(0, 7)}-01`;
}

export function monthEnd(year, month) {
  return new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
}

/**
 * Resolve an inclusive reporting period. Defaults to month-to-date in the
 * reporting timezone. Both ends are calendar dates; all queries use
 * `date BETWEEN from AND to`, so charts, tables and exports share boundaries.
 */
export function resolvePeriod({ from, to } = {}, { timezone = config.timezone, defaultFrom = 'month' } = {}) {
  const today = todayIn(timezone);
  const dateTo = to || today;
  let dateFrom = from;
  if (!dateFrom) dateFrom = defaultFrom === 'year' ? `${dateTo.slice(0, 4)}-01-01` : monthStart(dateTo);
  if (!isIsoDate(dateFrom) || !isIsoDate(dateTo)) {
    throw new AppError('Dates must use the YYYY-MM-DD format.', 400);
  }
  if (dateFrom > dateTo) throw new AppError('"from" must not be after "to".', 400);
  if (daysBetween(dateFrom, dateTo) > 3660) throw new AppError('Reporting period is limited to 10 years.', 400);
  return { from: dateFrom, to: dateTo, days: daysBetween(dateFrom, dateTo) + 1 };
}

/** The equally long period immediately before the given one (for growth comparisons). */
export function previousPeriod({ from, days }) {
  const prevTo = addDays(from, -1);
  return { from: addDays(prevTo, -(days - 1)), to: prevTo, days };
}

export function toIsoDate(value) {
  if (!value) return null;
  if (value instanceof Date) {
    // node-postgres returns DATE columns as local-midnight Date objects
    const y = value.getFullYear();
    const m = String(value.getMonth() + 1).padStart(2, '0');
    const d = String(value.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  return String(value).slice(0, 10);
}
