/**
 * Small UI toolkit shared by all pages.
 *
 * `html` is a tagged template that HTML-escapes every interpolated value unless
 * it is itself produced by `html` (or wrapped in `raw`). Pages build markup with
 * it so user- or server-provided text can never inject markup (XSS).
 */
import { t, formatCurrency, formatNumber, formatPercent, formatDate } from '../i18n/index.js';
import { exportsApi } from '../services/api.js';

class SafeHtml {
  constructor(value) { this.value = value; }
  toString() { return this.value; }
}

export function esc(value) {
  if (value instanceof SafeHtml) return value.value;
  return String(value ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export const raw = (value) => new SafeHtml(String(value ?? ''));

function interpolate(v) {
  if (v === null || v === undefined || v === false) return '';
  if (Array.isArray(v)) return v.map(interpolate).join('');
  return esc(v);
}

export function html(strings, ...values) {
  let out = strings[0];
  values.forEach((v, i) => { out += interpolate(v) + strings[i + 1]; });
  return new SafeHtml(out);
}

export function render(el, content) {
  if (!el) return;
  el.innerHTML = Array.isArray(content) ? content.map(String).join('') : String(content ?? '');
}

// ── Formatting ───────────────────────────────────────────────────────────────
export const money = (v, cur = 'IDR') => (v === null || v === undefined ? '—' : formatCurrency(Number(v), cur));
export const num = (v, d = 2) => (v === null || v === undefined ? '—' : formatNumber(Number(v), d));
export const pct = (v) => formatPercent(v);
export const date = (v) => formatDate(v);
export const tone = (v) => (v === null || v === undefined || Number(v) === 0 ? 'text-slate-300' : Number(v) > 0 ? 'tag-up' : 'tag-down');

export function compactMoney(v) {
  const n = Number(v || 0);
  const abs = Math.abs(n);
  if (abs >= 1e12) return `${(n / 1e12).toFixed(2)} T`;
  if (abs >= 1e9) return `${(n / 1e9).toFixed(2)} M`;
  if (abs >= 1e6) return `${(n / 1e6).toFixed(1)} jt`;
  if (abs >= 1e3) return `${(n / 1e3).toFixed(0)} rb`;
  return String(Math.round(n));
}

// ── Building blocks ──────────────────────────────────────────────────────────
export function spinner() {
  return html`<div class="flex justify-center py-16" role="status" aria-label="${t('common.loading')}"><div class="spinner"></div></div>`;
}

export function errorBox(err) {
  const msg = err?.status === 403 ? t('common.forbidden') : err?.message || t('common.error');
  return html`<div class="alert-error" role="alert"><span aria-hidden="true">⚠</span><span>${msg}</span></div>`;
}

export function emptyState(title, desc = '', icon = '📭') {
  return html`<div class="empty-state"><div class="text-4xl mb-3" aria-hidden="true">${icon}</div>
    <p class="empty-state-title">${title}</p>${desc ? html`<p class="empty-state-desc">${desc}</p>` : ''}</div>`;
}

export function kpi(label, value, { sub = '', subTone = '', hint = '' } = {}) {
  return html`<div class="metric-card">
    <p class="metric-label flex items-center gap-1">${label}${hint ? html`<span class="cursor-help text-slate-500" title="${hint}" aria-label="${hint}">ⓘ</span>` : ''}</p>
    <p class="metric-value font-mono">${value}</p>
    ${sub ? html`<p class="metric-change ${subTone}">${sub}</p>` : ''}
  </div>`;
}

export function demoBadge(isDemo) {
  return isDemo ? html`<span class="badge-yellow" title="${t('common.demoWarning')}">DEMO</span>` : '';
}

export function pageHeader(title, subtitle = '', actions = '') {
  return html`<div class="page-header flex-wrap gap-3">
    <div><h1>${title}</h1>${subtitle ? html`<p class="text-sm text-slate-400 mt-1">${subtitle}</p>` : ''}</div>
    <div class="flex flex-wrap items-center gap-2">${actions}</div>
  </div>`;
}

/** Date range with quick presets. Calls onChange({from,to}). */
export function periodPicker(id, { from, to }) {
  return html`<div class="flex flex-wrap items-end gap-2" id="${id}">
    <div><label class="form-label" for="${id}-from">${t('common.from')}</label>
      <input type="date" id="${id}-from" class="form-input py-1.5" value="${from}"></div>
    <div><label class="form-label" for="${id}-to">${t('common.to')}</label>
      <input type="date" id="${id}-to" class="form-input py-1.5" value="${to}"></div>
    <div class="flex gap-1">
      <button type="button" class="btn-secondary btn-sm" data-preset="mtd">${t('period.mtd')}</button>
      <button type="button" class="btn-secondary btn-sm" data-preset="last30">${t('period.last30')}</button>
      <button type="button" class="btn-secondary btn-sm" data-preset="ytd">${t('period.ytd')}</button>
    </div>
  </div>`;
}

export function todayIso() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jakarta' }).format(new Date());
}
export function shiftDays(iso, n) {
  const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10);
}
export function defaultPeriod(kind = 'mtd') {
  const to = todayIso();
  if (kind === 'ytd') return { from: `${to.slice(0, 4)}-01-01`, to };
  if (kind === 'last30') return { from: shiftDays(to, -29), to };
  if (kind === 'last6m') { const d = new Date(`${to.slice(0, 7)}-01T00:00:00Z`); d.setUTCMonth(d.getUTCMonth() - 5); return { from: d.toISOString().slice(0, 10), to }; }
  return { from: `${to.slice(0, 7)}-01`, to };
}

export function bindPeriodPicker(id, onChange) {
  const root = document.getElementById(id);
  if (!root) return;
  const fromEl = document.getElementById(`${id}-from`);
  const toEl = document.getElementById(`${id}-to`);
  const emit = () => {
    if (fromEl.value && toEl.value && fromEl.value <= toEl.value) onChange({ from: fromEl.value, to: toEl.value });
  };
  fromEl.addEventListener('change', emit);
  toEl.addEventListener('change', emit);
  root.querySelectorAll('[data-preset]').forEach((b) => b.addEventListener('click', () => {
    const p = defaultPeriod(b.dataset.preset);
    fromEl.value = p.from; toEl.value = p.to; emit();
  }));
}

/** Export dropdown (CSV / Excel / PDF). getParams() returns the current filters. */
export function exportButtons(id) {
  return html`<div class="flex gap-1" id="${id}" role="group" aria-label="${t('common.export')}">
    <button type="button" class="btn-secondary btn-sm" data-format="csv">CSV</button>
    <button type="button" class="btn-secondary btn-sm" data-format="xlsx">Excel</button>
    <button type="button" class="btn-secondary btn-sm" data-format="pdf">PDF</button>
  </div>`;
}

export function bindExportButtons(id, dataset, getParams) {
  document.getElementById(id)?.querySelectorAll('[data-format]').forEach((b) => b.addEventListener('click', async () => {
    const label = b.textContent;
    b.disabled = true; b.textContent = '…';
    try {
      await exportsApi.download(dataset, { ...getParams(), format: b.dataset.format });
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      b.disabled = false; b.textContent = label;
    }
  }));
}

// ── Modal and confirmation ───────────────────────────────────────────────────
let lastFocus = null;

export function openModal({ title, body, submitLabel = t('common.save'), danger = false, wide = false, onSubmit }) {
  closeModal();
  lastFocus = document.activeElement;
  const wrap = document.createElement('div');
  wrap.id = 'modal-root';
  wrap.className = 'modal-overlay';
  wrap.innerHTML = String(html`
    <form class="modal ${wide ? 'max-w-3xl' : ''}" role="dialog" aria-modal="true" aria-labelledby="modal-title" novalidate>
      <div class="modal-header"><h3 id="modal-title">${title}</h3>
        <button type="button" class="text-slate-400 hover:text-white" data-close aria-label="${t('common.close')}">✕</button></div>
      <div class="modal-body max-h-[70vh] overflow-y-auto space-y-4">${body}<div id="modal-error"></div></div>
      <div class="modal-footer">
        <button type="button" class="btn-secondary" data-close>${t('common.cancel')}</button>
        ${onSubmit ? html`<button type="submit" class="${danger ? 'btn-danger' : 'btn-primary'}" id="modal-submit">${submitLabel}</button>` : ''}
      </div>
    </form>`);
  document.body.appendChild(wrap);
  const form = wrap.querySelector('form');
  wrap.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', closeModal));
  wrap.addEventListener('mousedown', (e) => { if (e.target === wrap) closeModal(); });
  wrap.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!onSubmit) return;
    const btn = document.getElementById('modal-submit');
    const errEl = document.getElementById('modal-error');
    render(errEl, '');
    btn.disabled = true;
    try {
      const data = Object.fromEntries(new FormData(form).entries());
      const keep = await onSubmit(data, form);
      if (keep !== true) closeModal();
    } catch (err) {
      render(errEl, errorBox(err));
    } finally {
      if (document.body.contains(btn)) btn.disabled = false;
    }
  });
  setTimeout(() => form.querySelector('input,select,textarea,button[type=submit]')?.focus(), 30);
  return form;
}

export function closeModal() {
  document.getElementById('modal-root')?.remove();
  if (lastFocus && document.body.contains(lastFocus)) lastFocus.focus();
}

/** Confirmation for destructive or financially significant actions. Resolves to reason string or null. */
export function confirmAction({ title, message, confirmLabel = t('common.confirm'), requireReason = false }) {
  return new Promise((resolve) => {
    let done = false;
    openModal({
      title,
      danger: true,
      submitLabel: confirmLabel,
      body: html`<p class="text-sm text-slate-300">${message}</p>
        ${requireReason ? html`<div><label class="form-label" for="confirm-reason">${t('common.reason')}</label>
          <input id="confirm-reason" name="reason" class="form-input" required minlength="3" maxlength="500"></div>` : ''}`,
      onSubmit: (data) => {
        if (requireReason && (!data.reason || data.reason.trim().length < 3)) throw new Error(t('common.reasonRequired'));
        done = true;
        resolve(requireReason ? data.reason.trim() : true);
      },
    });
    const observer = new MutationObserver(() => {
      if (!document.getElementById('modal-root')) { observer.disconnect(); if (!done) resolve(null); }
    });
    observer.observe(document.body, { childList: true });
  });
}

export function field({ name, label, type = 'text', value = '', required = false, options = null, attrs = '', help = '' }) {
  const id = `f-${name}`;
  const control = options
    ? html`<select id="${id}" name="${name}" class="form-select" ${required ? raw('required') : ''} ${raw(attrs)}>
        ${options.map((o) => html`<option value="${o.value}" ${String(o.value) === String(value) ? raw('selected') : ''}>${o.label}</option>`)}
      </select>`
    : type === 'textarea'
      ? html`<textarea id="${id}" name="${name}" class="form-input" rows="2" ${raw(attrs)}>${value}</textarea>`
      : html`<input id="${id}" name="${name}" type="${type}" class="form-input" value="${value}" ${required ? raw('required') : ''} ${raw(attrs)}>`;
  return html`<div><label class="form-label" for="${id}">${label}${required ? ' *' : ''}</label>${control}
    ${help ? html`<p class="text-xxs text-slate-500 mt-1">${help}</p>` : ''}</div>`;
}

// ── Toasts ───────────────────────────────────────────────────────────────────
export function toast(message, type = 'success', duration = 4000) {
  const container = document.getElementById('toast-container');
  if (!container) return;
  const colors = {
    success: 'bg-green-900 text-green-100 border-green-700',
    error: 'bg-red-900 text-red-100 border-red-700',
    warning: 'bg-yellow-900 text-yellow-100 border-yellow-700',
    info: 'bg-blue-900 text-blue-100 border-blue-700',
  };
  const el = document.createElement('div');
  el.setAttribute('role', type === 'error' ? 'alert' : 'status');
  el.className = `flex items-center gap-3 px-4 py-3 rounded-lg border text-sm shadow-lg max-w-sm ${colors[type] || colors.info}`;
  el.innerHTML = String(html`<span class="flex-1">${message}</span><button class="opacity-60 hover:opacity-100" aria-label="${t('common.close')}">✕</button>`);
  el.querySelector('button').addEventListener('click', () => el.remove());
  container.appendChild(el);
  setTimeout(() => el.remove(), duration);
}

/** Simple client-side table sorting for rendered tables with data-sort headers. */
export function makeSortable(table, rows, renderRows) {
  let key = null; let dir = -1;
  table.querySelectorAll('th[data-sort]').forEach((th) => {
    th.classList.add('cursor-pointer', 'select-none');
    th.setAttribute('tabindex', '0');
    const handler = () => {
      const k = th.dataset.sort;
      dir = key === k ? -dir : -1; key = k;
      const sorted = [...rows].sort((a, b) => {
        const va = a[k]; const vb = b[k];
        if (va === null || va === undefined) return 1;
        if (vb === null || vb === undefined) return -1;
        return (typeof va === 'number' || !Number.isNaN(Number(va)) ? Number(va) - Number(vb) : String(va).localeCompare(String(vb))) * dir;
      });
      table.querySelectorAll('th[data-sort]').forEach((h) => h.removeAttribute('aria-sort'));
      th.setAttribute('aria-sort', dir === 1 ? 'ascending' : 'descending');
      renderRows(sorted);
    };
    th.addEventListener('click', handler);
    th.addEventListener('keydown', (e) => { if (e.key === 'Enter') handler(); });
  });
}

export function pager(meta, onPage) {
  if (!meta || meta.totalPages <= 1) return '';
  return html`<div class="flex items-center justify-between text-xs text-slate-400 mt-3" data-pager>
    <span>${t('common.page')} ${meta.page} / ${meta.totalPages} · ${num(meta.total, 0)} ${t('common.rows')}</span>
    <div class="flex gap-1">
      <button class="btn-secondary btn-sm" data-page="${meta.page - 1}" ${meta.page <= 1 ? raw('disabled') : ''}>‹</button>
      <button class="btn-secondary btn-sm" data-page="${meta.page + 1}" ${meta.page >= meta.totalPages ? raw('disabled') : ''}>›</button>
    </div></div>`;
}

export function bindPager(root, onPage) {
  root?.querySelectorAll('[data-page]').forEach((b) => b.addEventListener('click', () => onPage(Number(b.dataset.page))));
}
