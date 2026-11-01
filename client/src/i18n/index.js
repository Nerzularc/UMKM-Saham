/**
 * Internationalisation — Indonesian (id, default) and English (en).
 * All user-facing text lives in ./messages.js; pages call t('key', vars).
 * Numbers, dates and currency use Intl with the active locale.
 */
import { messages } from './messages.js';

let currentLocale = 'id';
try { currentLocale = localStorage.getItem('locale') || 'id'; } catch { /* storage unavailable */ }
if (!messages[currentLocale]) currentLocale = 'id';

export function setLocale(locale) {
  if (!messages[locale]) return;
  currentLocale = locale;
  try { localStorage.setItem('locale', locale); } catch { /* ignore */ }
  document.documentElement.lang = locale;
}

export function getLocale() {
  return currentLocale;
}

const intlLocale = () => (currentLocale === 'id' ? 'id-ID' : 'en-US');

export function t(key, vars = {}, fallback) {
  let str = messages[currentLocale]?.[key] ?? messages.en?.[key];
  if (str === undefined) {
    if (import.meta.env?.DEV) console.warn(`[i18n] missing key: ${key}`);
    str = fallback ?? key;
  }
  if (!vars || !Object.keys(vars).length) return str;
  return str.replace(/\{(\w+)\}/g, (_, k) => (vars[k] ?? `{${k}}`));
}

export function formatCurrency(amount, currency = 'IDR') {
  const n = Number(amount ?? 0);
  try {
    return new Intl.NumberFormat(intlLocale(), {
      style: 'currency', currency,
      minimumFractionDigits: 0,
      maximumFractionDigits: currency === 'IDR' || currency === 'JPY' ? 0 : 2,
    }).format(n);
  } catch {
    return `${currency} ${n.toLocaleString(intlLocale())}`;
  }
}

export function formatNumber(n, decimals = 2) {
  return new Intl.NumberFormat(intlLocale(), { minimumFractionDigits: 0, maximumFractionDigits: decimals }).format(Number(n ?? 0));
}

export function formatPercent(n, decimals = 2) {
  if (n === null || n === undefined || Number.isNaN(Number(n))) return '—';
  const v = Number(n);
  return `${v > 0 ? '+' : ''}${new Intl.NumberFormat(intlLocale(), { minimumFractionDigits: decimals, maximumFractionDigits: decimals }).format(v)}%`;
}

export function formatDate(value) {
  if (!value) return '—';
  // Calendar dates (YYYY-MM-DD) are rendered without timezone shifting.
  const d = typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T00:00:00`) : new Date(value);
  if (Number.isNaN(d.getTime())) return '—';
  return new Intl.DateTimeFormat(intlLocale(), { year: 'numeric', month: 'short', day: 'numeric' }).format(d);
}
