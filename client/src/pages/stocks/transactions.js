import { transactions, instruments } from '../../services/api.js';
import { t } from '../../i18n/index.js';
import {
  html, render, spinner, errorBox, emptyState, pageHeader, money, num, date, openModal, field, confirmAction, toast,
  exportButtons, bindExportButtons, pager, bindPager, todayIso, raw,
} from '../../components/ui.js';
import { loadPortfolios, rememberPortfolio } from './shared.js';

const TYPES = ['buy', 'sell', 'dividend', 'deposit', 'withdrawal', 'fee', 'split'];
const TYPE_BADGE = { buy: 'badge-green', sell: 'badge-red', dividend: 'badge-purple', deposit: 'badge-blue', withdrawal: 'badge-yellow', fee: 'badge-gray', split: 'badge-gray' };

export async function renderTransactions(el, params = {}) {
  render(el, spinner());
  let list; let selected;
  try { [list, selected] = await loadPortfolios(params); } catch (err) { return render(el, errorBox(err)); }
  const state = { portfolioId: params.portfolio || '', type: '', from: '', to: '', page: 1, sort: 'date', order: 'desc' };

  render(el, html`
    ${pageHeader(t('stocks.transactions'), t('tx.subtitle'), html`${exportButtons('tx-export')}<button id="tx-new" class="btn-primary" ${list.length ? '' : raw('disabled')}>+ ${t('tx.new')}</button>`)}
    <div class="card mb-4 flex flex-wrap gap-3 items-end">
      <div><label class="form-label" for="f-pf">${t('portfolio.title')}</label>
        <select id="f-pf" class="form-select py-1.5"><option value="">${t('common.all')}</option>
        ${list.map((p) => html`<option value="${p.id}" ${p.id === state.portfolioId ? raw('selected') : ''}>${p.name}</option>`)}</select></div>
      <div><label class="form-label" for="f-type">${t('tx.type')}</label>
        <select id="f-type" class="form-select py-1.5"><option value="">${t('common.all')}</option>${TYPES.map((x) => html`<option value="${x}">${t(`tx.${x}`)}</option>`)}</select></div>
      <div><label class="form-label" for="f-from">${t('common.from')}</label><input type="date" id="f-from" class="form-input py-1.5"></div>
      <div><label class="form-label" for="f-to">${t('common.to')}</label><input type="date" id="f-to" class="form-input py-1.5"></div>
      <div><label class="form-label" for="f-sort">${t('common.sort')}</label>
        <select id="f-sort" class="form-select py-1.5"><option value="date">${t('common.date')}</option><option value="amount">${t('common.amount')}</option><option value="symbol">${t('stocks.symbol')}</option></select></div>
    </div>
    <div id="tx-table">${spinner()}</div>`);

  const filters = () => ({ portfolioId: state.portfolioId, type: state.type, from: state.from, to: state.to });
  bindExportButtons('tx-export', 'stock-transactions', filters);
  const on = (id, key) => document.getElementById(id).addEventListener('change', (e) => { state[key] = e.target.value; state.page = 1; if (key === 'portfolioId' && e.target.value) rememberPortfolio(e.target.value); load(); });
  on('f-pf', 'portfolioId'); on('f-type', 'type'); on('f-from', 'from'); on('f-to', 'to'); on('f-sort', 'sort');
  document.getElementById('tx-new')?.addEventListener('click', () => txForm(null, list, state.portfolioId || selected, load));

  async function load() {
    const target = document.getElementById('tx-table');
    render(target, spinner());
    try {
      const res = await transactions.list({ ...filters(), page: state.page, limit: 50, sort: state.sort, order: state.order });
      if (!res.data.length) return render(target, html`<div class="card">${emptyState(t('tx.empty'), t('tx.emptyDesc'))}</div>`);
      render(target, html`<div class="table-container"><table>
        <thead><tr><th>${t('common.date')}</th><th>${t('tx.type')}</th><th>${t('stocks.symbol')}</th><th>${t('portfolio.title')}</th>
          <th class="text-right">${t('stocks.quantity')}</th><th class="text-right">${t('stocks.price')}</th><th class="text-right">${t('tx.fee')}</th>
          <th class="text-right">${t('common.amount')}</th><th class="text-right">${t('tx.baseAmount')}</th><th><span class="sr-only">${t('common.actions')}</span></th></tr></thead>
        <tbody>${res.data.map((x) => html`<tr>
          <td class="whitespace-nowrap">${date(x.transaction_date)}</td>
          <td><span class="${TYPE_BADGE[x.transaction_type]}">${t(`tx.${x.transaction_type}`)}</span>
            ${x.is_simulated ? html`<span class="badge-purple">SIM</span>` : ''}${x.is_demo ? html`<span class="badge-yellow">DEMO</span>` : ''}</td>
          <td class="font-mono">${x.symbol || '—'}<div class="text-xxs text-slate-500">${x.exchange_code || ''}</div></td>
          <td class="text-xs text-slate-400">${x.portfolio_name}</td>
          <td class="text-right font-mono">${x.quantity === null ? '—' : num(x.quantity, 4)}</td>
          <td class="text-right font-mono">${x.price === null ? '—' : num(x.price, 4)}</td>
          <td class="text-right font-mono">${num(x.fee, 2)}</td>
          <td class="text-right font-mono">${money(x.total_amount, x.currency)}</td>
          <td class="text-right font-mono">${money(x.base_amount, x.base_currency)}${x.currency !== x.base_currency ? html`<div class="text-xxs text-slate-500">@ ${num(x.exchange_rate, 4)}</div>` : ''}</td>
          <td class="whitespace-nowrap"><button class="btn-secondary btn-sm" data-edit="${x.id}" aria-label="${t('common.edit')}">✎</button>
            <button class="btn-secondary btn-sm text-red-300" data-del="${x.id}" aria-label="${t('common.delete')}">✕</button></td>
        </tr>`)}</tbody></table></div>${pager(res.meta)}`);
      bindPager(target, (p) => { state.page = p; load(); });
      target.querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', () => txForm(res.data.find((x) => x.id === b.dataset.edit), list, null, load)));
      target.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', async () => {
        const reason = await confirmAction({ title: t('tx.deleteTitle'), message: t('tx.deleteMsg'), confirmLabel: t('common.delete'), requireReason: true });
        if (!reason) return;
        try { await transactions.delete(b.dataset.del, reason); toast(t('common.deleted')); load(); } catch (err) { toast(err.message, 'error'); }
      }));
    } catch (err) { render(target, errorBox(err)); }
  }
  await load();
}

function txForm(tx, list, defaultPortfolio, done) {
  const editing = !!tx;
  const form = openModal({
    title: editing ? t('tx.correct') : t('tx.new'),
    wide: true,
    body: html`
      ${editing ? html`<div class="alert-info"><span>ⓘ</span><span>${t('tx.correctionNotice')}</span></div>` : ''}
      <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
        ${field({ name: 'portfolioId', label: t('portfolio.title'), value: tx?.portfolio_id || defaultPortfolio, options: list.map((p) => ({ value: p.id, label: p.name })), attrs: editing ? 'disabled' : '' })}
        ${field({ name: 'transactionType', label: t('tx.type'), value: tx?.transaction_type || 'buy', options: TYPES.map((x) => ({ value: x, label: t(`tx.${x}`) })) })}
        ${field({ name: 'transactionDate', label: t('common.date'), type: 'date', value: tx?.transaction_date || todayIso(), required: true, attrs: `max="${todayIso()}"` })}
        <div data-for="instrument"><label class="form-label" for="f-instrument">${t('stocks.instrument')} *</label>
          <input id="f-instrument" class="form-input" list="instrument-options" autocomplete="off" placeholder="BBCA, AAPL…" value="${tx?.symbol || ''}">
          <input type="hidden" name="instrumentId" id="f-instrumentId" value="${tx?.instrument_id || ''}">
          <datalist id="instrument-options"></datalist><p id="instrument-info" class="text-xxs text-slate-500 mt-1"></p></div>
        <div data-for="qty">${field({ name: 'quantity', label: t('stocks.quantity'), type: 'number', value: tx?.quantity ?? '', attrs: 'step="any" min="0"' })}</div>
        <div data-for="price">${field({ name: 'price', label: t('stocks.price'), type: 'number', value: tx?.price ?? '', attrs: 'step="any" min="0"' })}</div>
        <div data-for="fee">${field({ name: 'fee', label: t('tx.fee'), type: 'number', value: tx?.fee ?? 0, attrs: 'step="any" min="0"' })}</div>
        <div data-for="amount">${field({ name: 'totalAmount', label: t('common.amount'), type: 'number', value: tx?.total_amount ?? '', attrs: 'step="any" min="0"', help: t('tx.amountHelp') })}</div>
        <div data-for="currency">${field({ name: 'currency', label: t('common.currency'), value: tx?.currency || '', attrs: 'maxlength="3" placeholder="IDR"' })}</div>
        <div data-for="fx">${field({ name: 'exchangeRate', label: t('tx.fxRate'), type: 'number', value: tx && tx.exchange_rate !== '1.00000000' ? tx.exchange_rate : '', attrs: 'step="any" min="0"', help: t('tx.fxHelp') })}</div>
        ${field({ name: 'reference', label: t('tx.reference'), value: tx?.reference || '' })}
        ${field({ name: 'notes', label: t('tx.notes'), value: tx?.notes || '' })}
      </div>
      <p id="tx-preview" class="text-sm text-slate-400"></p>
      ${editing ? field({ name: 'reason', label: t('common.reason'), required: true, attrs: 'minlength="3"' }) : ''}`,
    onSubmit: async (data) => {
      const body = { ...data };
      for (const k of ['quantity', 'price', 'fee', 'totalAmount', 'exchangeRate']) body[k] = body[k] === '' || body[k] === undefined ? null : Number(body[k]);
      if (!body.instrumentId) delete body.instrumentId;
      if (!body.currency) delete body.currency;
      if (editing) {
        await transactions.update(tx.id, body);
      } else {
        await transactions.create(body);
      }
      toast(t('common.saved'));
      done();
    },
  });

  const typeEl = form.querySelector('[name=transactionType]');
  const show = () => {
    const ty = typeEl.value;
    const vis = {
      instrument: ['buy', 'sell', 'dividend', 'split'].includes(ty),
      qty: ['buy', 'sell', 'split'].includes(ty),
      price: ['buy', 'sell'].includes(ty),
      fee: ['buy', 'sell', 'dividend'].includes(ty),
      amount: ['dividend', 'deposit', 'withdrawal', 'fee'].includes(ty),
      currency: !['buy', 'sell', 'split', 'dividend'].includes(ty),
      fx: ty !== 'split',
    };
    for (const [k, v] of Object.entries(vis)) form.querySelector(`[data-for=${k}]`).classList.toggle('hidden', !v);
    form.querySelector('label[for="f-quantity"]').textContent = ty === 'split' ? t('tx.splitRatio') : t('stocks.quantity');
    preview();
  };
  const preview = () => {
    const q = Number(form.quantity.value); const p = Number(form.price.value); const f = Number(form.fee.value || 0);
    const el = document.getElementById('tx-preview');
    if (['buy', 'sell'].includes(typeEl.value) && q && p) {
      el.textContent = `${t('tx.grossValue')}: ${num(q * p, 2)} · ${typeEl.value === 'buy' ? t('tx.totalCost') : t('tx.netProceeds')}: ${num(typeEl.value === 'buy' ? q * p + f : q * p - f, 2)}`;
    } else el.textContent = '';
  };
  typeEl.addEventListener('change', show);
  ['quantity', 'price', 'fee'].forEach((n) => form[n].addEventListener('input', preview));

  // Instrument search (only supported instruments can be selected)
  const input = document.getElementById('f-instrument');
  const hidden = document.getElementById('f-instrumentId');
  const options = document.getElementById('instrument-options');
  const info = document.getElementById('instrument-info');
  let found = [];
  let timer;
  input.addEventListener('input', () => {
    clearTimeout(timer);
    hidden.value = '';
    const match = found.find((i) => `${i.symbol} · ${i.exchange_code}` === input.value || i.symbol === input.value.toUpperCase());
    if (match) { hidden.value = match.id; info.textContent = `${match.name} · ${match.currency}${match.is_demo ? ' · DEMO' : ''}`; return; }
    timer = setTimeout(async () => {
      try {
        found = (await instruments.list({ q: input.value, limit: 15 })).data;
        render(options, found.map((i) => html`<option value="${i.symbol} · ${i.exchange_code}">${i.name}</option>`));
        const exact = found.find((i) => i.symbol === input.value.toUpperCase());
        if (exact && found.filter((i) => i.symbol === exact.symbol).length === 1) { hidden.value = exact.id; info.textContent = `${exact.name} · ${exact.currency}`; }
        else info.textContent = found.length ? '' : t('tx.instrumentUnsupported');
      } catch { /* ignore */ }
    }, 250);
  });
  input.addEventListener('change', () => input.dispatchEvent(new Event('input')));
  show();
}
