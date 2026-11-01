import { watchlists, instruments } from '../../services/api.js';
import { t } from '../../i18n/index.js';
import { html, render, spinner, errorBox, emptyState, pageHeader, num, pct, tone, demoBadge, date, openModal, field, confirmAction, toast } from '../../components/ui.js';
import { renderChart, lineChartConfig } from '../../components/chart.js';

export async function renderWatchlist(el) {
  render(el, html`${pageHeader(t('stocks.watchlist'), t('watch.subtitle'), html`<button id="wl-new" class="btn-secondary">+ ${t('watch.new')}</button>`)}<div id="wl-body">${spinner()}</div>`);
  document.getElementById('wl-new').addEventListener('click', () => openModal({
    title: t('watch.new'),
    body: field({ name: 'name', label: t('common.name'), required: true }),
    onSubmit: async (d) => { await watchlists.create(d); load(); },
  }));

  let active = null;
  async function load() {
    const body = document.getElementById('wl-body');
    try {
      const { data: lists } = await watchlists.list();
      if (!lists.length) return render(body, html`<div class="card">${emptyState(t('watch.empty'), t('watch.emptyDesc'), '⭐')}</div>`);
      active = lists.find((l) => l.id === active)?.id || lists[0].id;
      render(body, html`
        <div class="flex flex-wrap gap-2 mb-4" role="tablist">${lists.map((l) => html`<button role="tab" aria-selected="${l.id === active}" class="${l.id === active ? 'btn-primary' : 'btn-secondary'} btn-sm" data-wl="${l.id}">${l.name} (${l.item_count})</button>`)}</div>
        <div class="card mb-4 flex flex-wrap gap-2 items-end">
          <div class="flex-1 min-w-[200px]"><label class="form-label" for="wl-search">${t('watch.add')}</label>
            <input id="wl-search" class="form-input" placeholder="${t('watch.searchPlaceholder')}" autocomplete="off"></div>
          <button class="btn-secondary btn-sm text-red-300" id="wl-delete">${t('watch.deleteList')}</button>
          <div id="wl-results" class="w-full"></div>
        </div>
        <div id="wl-items">${spinner()}</div>
        <div class="card mt-4 hidden" id="wl-chart-card"><div class="card-header"><h3 id="wl-chart-title"></h3></div>
          <div class="chart-container"><canvas id="wl-chart" role="img"></canvas></div></div>`);
      body.querySelectorAll('[data-wl]').forEach((b) => b.addEventListener('click', () => { active = b.dataset.wl; load(); }));
      document.getElementById('wl-delete').addEventListener('click', async () => {
        if (!(await confirmAction({ title: t('watch.deleteList'), message: t('watch.deleteMsg'), confirmLabel: t('common.delete') }))) return;
        await watchlists.remove(active); active = null; load();
      });
      let timer;
      document.getElementById('wl-search').addEventListener('input', (e) => {
        clearTimeout(timer);
        const q = e.target.value.trim();
        const res = document.getElementById('wl-results');
        if (q.length < 1) return render(res, '');
        timer = setTimeout(async () => {
          const { data } = await instruments.list({ q, limit: 8 });
          render(res, data.length ? html`<ul class="divide-y divide-slate-800 border border-slate-800 rounded-lg mt-2">${data.map((i) => html`<li class="flex items-center justify-between px-3 py-2">
            <span><span class="font-mono font-semibold">${i.symbol}</span> <span class="text-xs text-slate-400">${i.name} · ${i.exchange_code}</span></span>
            <button class="btn-secondary btn-sm" data-add="${i.id}">+ ${t('common.add')}</button></li>`)}</ul>` : html`<p class="text-xs text-slate-500 mt-2">${t('tx.instrumentUnsupported')}</p>`);
          res.querySelectorAll('[data-add]').forEach((b) => b.addEventListener('click', async () => {
            await watchlists.addItem(active, b.dataset.add); toast(t('common.saved')); load();
          }));
        }, 250);
      });
      loadItems();
    } catch (err) { render(body, errorBox(err)); }
  }

  async function loadItems() {
    const target = document.getElementById('wl-items');
    try {
      const { data } = await watchlists.items(active);
      if (!data.length) return render(target, emptyState(t('watch.noItems')));
      render(target, html`<div class="table-container"><table>
        <thead><tr><th>${t('stocks.symbol')}</th><th>${t('stocks.exchange')}</th><th class="text-right">${t('stocks.lastPrice')}</th>
          <th class="text-right">${t('watch.change')}</th><th>${t('holdings.priceTime')}</th><th></th></tr></thead>
        <tbody>${data.map((i) => {
          const chg = i.previous_close ? ((Number(i.last_price) - Number(i.previous_close)) / Number(i.previous_close)) * 100 : null;
          return html`<tr>
            <td><button class="font-mono font-semibold text-brand-300 hover:underline" data-chart="${i.instrument_id}" data-sym="${i.symbol}">${i.symbol}</button><div class="text-xxs text-slate-500">${i.instrument_name}</div></td>
            <td class="text-xs">${i.exchange_code}</td>
            <td class="text-right font-mono">${num(i.last_price, 2)} ${i.currency} ${demoBadge(i.is_demo)}</td>
            <td class="text-right font-mono ${tone(chg)}">${chg === null ? '—' : pct(Math.round(chg * 100) / 100)}</td>
            <td class="text-xxs ${i.price_stale ? 'text-yellow-400' : 'text-slate-500'}">${i.last_price_at ? date(i.last_price_at) : '—'} ${i.price_stale ? `· ${t('stocks.priceStale')}` : ''}<div>${i.price_source || ''}</div></td>
            <td><button class="btn-secondary btn-sm" data-rm="${i.instrument_id}" aria-label="${t('common.remove')} ${i.symbol}">✕</button></td></tr>`;
        })}</tbody></table></div>`);
      target.querySelectorAll('[data-rm]').forEach((b) => b.addEventListener('click', async () => { await watchlists.removeItem(active, b.dataset.rm); load(); }));
      target.querySelectorAll('[data-chart]').forEach((b) => b.addEventListener('click', async () => {
        const { data: prices } = await instruments.prices(b.dataset.chart, { limit: 250 });
        document.getElementById('wl-chart-card').classList.remove('hidden');
        document.getElementById('wl-chart-title').textContent = `${b.dataset.sym} · ${t('watch.history')}`;
        if (!prices.length) return;
        renderChart('wl-chart', lineChartConfig({ labels: prices.map((p) => p.price_date), datasets: [{ label: b.dataset.sym, data: prices.map((p) => Number(p.close_price)) }] }), prices.some((p) => p.is_demo));
      }));
    } catch (err) { render(target, errorBox(err)); }
  }
  await load();
}
