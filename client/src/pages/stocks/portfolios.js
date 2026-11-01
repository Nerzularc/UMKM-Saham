import { portfolios } from '../../services/api.js';
import { t } from '../../i18n/index.js';
import { html, render, spinner, errorBox, emptyState, pageHeader, openModal, field, confirmAction, toast, date } from '../../components/ui.js';

const CURRENCIES = ['IDR', 'USD', 'SGD', 'EUR', 'GBP', 'JPY', 'HKD'];

export async function renderPortfolios(el) {
  render(el, html`${pageHeader(t('portfolio.title'), t('portfolio.subtitle'), html`<button id="new-pf" class="btn-primary">+ ${t('portfolio.new')}</button>`)}
    <div class="mb-4"><label class="sr-only" for="pf-search">${t('common.search')}</label>
      <input id="pf-search" class="form-input max-w-xs" placeholder="${t('common.search')}…"></div>
    <div id="pf-list">${spinner()}</div>`);
  document.getElementById('new-pf').addEventListener('click', () => editPortfolio(null, load));
  document.getElementById('pf-search').addEventListener('input', (e) => draw(e.target.value));

  let list = [];
  async function load() {
    try {
      list = (await portfolios.list()).data;
      draw(document.getElementById('pf-search').value);
    } catch (err) { render(document.getElementById('pf-list'), errorBox(err)); }
  }

  function draw(q = '') {
    const target = document.getElementById('pf-list');
    const rows = list.filter((p) => p.name.toLowerCase().includes(q.toLowerCase()));
    if (!list.length) return render(target, html`<div class="card">${emptyState(t('portfolio.empty'), t('portfolio.emptyDesc'), '📈')}</div>`);
    render(target, html`<div class="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
      ${rows.map((p) => html`<article class="card flex flex-col gap-3">
        <div class="flex items-start justify-between gap-2">
          <div><h3 class="text-slate-100">${p.name}</h3><p class="text-xs text-slate-500">${p.description || ''}</p></div>
          <div class="flex flex-col items-end gap-1">
            ${p.portfolio_type === 'simulation' ? html`<span class="badge-purple">${t('portfolio.simulation')}</span>` : html`<span class="badge-blue">${t('portfolio.tracking')}</span>`}
            ${p.is_default ? html`<span class="badge-gray">${t('portfolio.default')}</span>` : ''}
          </div>
        </div>
        <dl class="grid grid-cols-3 gap-2 text-xs">
          <div><dt class="text-slate-500">${t('portfolio.baseCurrency')}</dt><dd class="font-mono text-slate-200">${p.base_currency}</dd></div>
          <div><dt class="text-slate-500">${t('portfolio.costBasis')}</dt><dd class="font-mono text-slate-200">${p.cost_basis_method}</dd></div>
          <div><dt class="text-slate-500">${t('stocks.transactions')}</dt><dd class="font-mono text-slate-200">${p.transaction_count}</dd></div>
        </dl>
        <p class="text-xxs text-slate-500">${t('common.created')} ${date(p.created_at)}</p>
        <div class="flex gap-2 mt-auto">
          <a class="btn-primary btn-sm" href="#/stocks/holdings?portfolio=${p.id}">${t('portfolio.open')}</a>
          <a class="btn-secondary btn-sm" href="#/stocks/transactions?portfolio=${p.id}">${t('stocks.transactions')}</a>
          <button class="btn-secondary btn-sm" data-edit="${p.id}">${t('common.edit')}</button>
          <button class="btn-secondary btn-sm text-red-300" data-del="${p.id}" aria-label="${t('common.delete')} ${p.name}">✕</button>
        </div>
      </article>`)}
    </div>`);
    target.querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', () => editPortfolio(list.find((p) => p.id === b.dataset.edit), load)));
    target.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', async () => {
      const p = list.find((x) => x.id === b.dataset.del);
      const ok = await confirmAction({ title: t('portfolio.deleteTitle'), message: t('portfolio.deleteMsg', { name: p.name }), confirmLabel: t('common.delete') });
      if (!ok) return;
      try { await portfolios.delete(p.id); toast(t('common.deleted')); load(); } catch (err) { toast(err.message, 'error'); }
    }));
  }

  await load();
}

function editPortfolio(p, done) {
  const hasTx = p && Number(p.transaction_count) > 0;
  openModal({
    title: p ? t('portfolio.edit') : t('portfolio.new'),
    body: html`
      ${field({ name: 'name', label: t('common.name'), value: p?.name || '', required: true, attrs: 'maxlength="255"' })}
      ${field({ name: 'description', label: t('common.description'), type: 'textarea', value: p?.description || '' })}
      <div class="grid grid-cols-2 gap-3">
        ${field({ name: 'baseCurrency', label: t('portfolio.baseCurrency'), value: p?.base_currency || 'IDR', options: CURRENCIES.map((c) => ({ value: c, label: c })), attrs: hasTx ? 'disabled' : '', help: hasTx ? t('portfolio.currencyLocked') : '' })}
        ${field({ name: 'costBasisMethod', label: t('portfolio.costBasis'), value: p?.cost_basis_method || 'WAC', options: [{ value: 'WAC', label: t('portfolio.wac') }, { value: 'FIFO', label: 'FIFO' }] })}
      </div>
      ${p ? '' : field({ name: 'portfolioType', label: t('portfolio.type'), value: 'tracking', options: [{ value: 'tracking', label: t('portfolio.tracking') }, { value: 'simulation', label: t('portfolio.simulationLong') }], help: t('portfolio.simulationHelp') })}`,
    onSubmit: async (data) => {
      if (p) await portfolios.update(p.id, data);
      else await portfolios.create(data);
      toast(t('common.saved'));
      done();
    },
  });
}
