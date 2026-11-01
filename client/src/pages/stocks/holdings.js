import { portfolios } from '../../services/api.js';
import { t } from '../../i18n/index.js';
import {
  html, render, spinner, errorBox, emptyState, pageHeader, kpi, money, num, pct, tone, demoBadge, date,
  exportButtons, bindExportButtons, makeSortable, compactMoney,
} from '../../components/ui.js';
import { renderChart, lineChartConfig, doughnutChartConfig, barChartConfig } from '../../components/chart.js';
import { loadPortfolios, portfolioSelect, rememberPortfolio } from './shared.js';

export async function renderHoldings(el, params = {}) {
  render(el, spinner());
  let list; let selected;
  try { [list, selected] = await loadPortfolios(params); } catch (err) { return render(el, errorBox(err)); }
  if (!selected) return render(el, html`${pageHeader(t('nav.holdings'))}<div class="card">${emptyState(t('portfolio.empty'), t('portfolio.emptyDesc'), '📈')}<div class="text-center"><a class="btn-primary" href="#/stocks">${t('portfolio.new')}</a></div></div>`);

  render(el, html`
    ${pageHeader(t('nav.holdings'), t('holdings.subtitle'), html`${portfolioSelect(list, selected)}${exportButtons('hold-export')}`)}
    <div id="hold-body">${spinner()}</div>`);
  document.getElementById('portfolio-select').addEventListener('change', (e) => { selected = e.target.value; rememberPortfolio(selected); load(); });
  bindExportButtons('hold-export', 'stock-holdings', () => ({ portfolioId: selected }));

  async function load() {
    const body = document.getElementById('hold-body');
    render(body, spinner());
    try {
      const { data } = await portfolios.holdings(selected);
      draw(body, data);
      loadPerformance(data.summary.baseCurrency);
    } catch (err) { render(body, errorBox(err)); }
  }

  function draw(body, { summary: s, holdings, allocation, warnings, portfolio }) {
    const ccy = s.baseCurrency;
    const open = holdings.filter((h) => h.isOpen);
    render(body, html`
      ${portfolio.portfolio_type === 'simulation' ? html`<div class="alert-info mb-4"><span>ⓘ</span><span>${t('portfolio.simulationNotice')}</span></div>` : ''}
      ${s.pricesAreDemo ? html`<div class="alert-warning mb-4"><span>⚠</span><span>${t('holdings.demoNotice')}</span></div>` : ''}
      ${warnings.length ? html`<div class="alert-warning mb-4"><span>⚠</span><ul class="list-disc ml-4">${warnings.map((w) => html`<li>${w}</li>`)}</ul></div>` : ''}
      <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        ${kpi(t('portfolio.totalValue'), money(s.totalValue, ccy), { sub: s.cashTracking ? `${t('holdings.cash')} ${money(s.cashBalance, ccy)}` : t('holdings.positionsOnly') })}
        ${kpi(t('portfolio.unrealised'), money(s.unrealisedPnl, ccy), { sub: pct(s.unrealisedPct), subTone: tone(s.unrealisedPnl), hint: t('hint.unrealised') })}
        ${kpi(t('portfolio.realised'), money(s.realisedPnl, ccy), { sub: `${t('portfolio.dividends')} ${money(s.dividends, ccy)}`, subTone: tone(s.realisedPnl), hint: t('hint.realised') })}
        ${kpi(t('portfolio.return'), money(s.totalReturn, ccy), { sub: pct(s.totalReturnPct), subTone: tone(s.totalReturn), hint: t('hint.totalReturn') })}
      </div>

      <section class="card mb-6" aria-labelledby="perf-title">
        <div class="card-header flex-wrap gap-3">
          <h3 id="perf-title">${t('holdings.performance')}</h3>
          <div class="flex flex-wrap items-center gap-2 text-xs">
            <label class="text-slate-400" for="cmp-select">${t('holdings.compareWith')}</label>
            <select id="cmp-select" class="form-select py-1 w-auto text-xs"><option value="">—</option>
              ${list.filter((p) => p.id !== selected).map((p) => html`<option value="${p.id}">${p.name}</option>`)}</select>
            <select id="perf-range" class="form-select py-1 w-auto text-xs" aria-label="${t('common.period')}">
              <option value="all">${t('period.all')}</option><option value="1y">1Y</option><option value="ytd">YTD</option><option value="6m">6M</option>
            </select>
          </div>
        </div>
        <div id="perf-metrics" class="grid grid-cols-2 md:grid-cols-4 gap-3 mb-3 text-sm"></div>
        <div class="chart-container" style="height:280px"><canvas id="perf-chart" role="img" aria-label="${t('holdings.performance')}"></canvas></div>
        <div id="perf-notes" class="mt-2 text-xxs text-slate-500 space-y-1"></div>
      </section>

      <div class="grid grid-cols-1 lg:grid-cols-3 gap-6 mb-6">
        <section class="card"><div class="card-header"><h3>${t('holdings.allocation')}</h3>
          <select id="alloc-by" class="form-select py-1 w-auto text-xs" aria-label="${t('holdings.groupBy')}">
            <option value="byInstrument">${t('stocks.symbol')}</option><option value="bySector">${t('stocks.sector')}</option>
            <option value="byExchange">${t('stocks.exchange')}</option><option value="byCurrency">${t('common.currency')}</option></select></div>
          ${open.length ? html`<div class="chart-container"><canvas id="alloc-chart" role="img" aria-label="${t('holdings.allocation')}"></canvas></div>` : emptyState(t('holdings.noOpen'))}
        </section>
        <section class="card lg:col-span-2"><div class="card-header"><h3>${t('holdings.pnlByInstrument')}</h3></div>
          <div class="chart-container"><canvas id="pnl-chart" role="img" aria-label="${t('holdings.pnlByInstrument')}"></canvas></div></section>
      </div>

      <section aria-labelledby="pos-title">
        <h3 id="pos-title" class="mb-3">${t('holdings.positions')} <span class="text-xs text-slate-500 font-normal">· ${t('portfolio.costBasis')}: ${s.costBasisMethod}</span></h3>
        ${holdings.length ? html`<div class="table-container"><table id="hold-table">
          <thead><tr>
            <th data-sort="symbol">${t('stocks.symbol')}</th><th data-sort="openQty" class="text-right">${t('stocks.quantity')}</th>
            <th data-sort="wac" class="text-right">${t('holdings.avgCost')}</th><th data-sort="priceInBase" class="text-right">${t('stocks.price')}</th>
            <th data-sort="marketValue" class="text-right">${t('holdings.marketValue')}</th><th data-sort="unrealisedPnl" class="text-right">${t('portfolio.unrealised')}</th>
            <th data-sort="realisedPnl" class="text-right">${t('portfolio.realised')}</th><th data-sort="totalReturnPct" class="text-right">${t('portfolio.return')}</th>
            <th>${t('holdings.priceTime')}</th></tr></thead>
          <tbody id="hold-rows"></tbody></table></div>` : emptyState(t('holdings.noOpen'), t('holdings.noOpenDesc'))}
      </section>`);

    const rowsEl = document.getElementById('hold-rows');
    const drawRows = (rows) => render(rowsEl, rows.map((h) => html`<tr class="${h.isOpen ? '' : 'opacity-60'}">
      <td><div class="font-mono font-semibold">${h.symbol}</div><div class="text-xxs text-slate-500">${h.exchangeCode} · ${h.name}</div></td>
      <td class="text-right font-mono">${num(h.openQty, 4)}</td>
      <td class="text-right font-mono">${num(h.wac, 2)}</td>
      <td class="text-right font-mono">${h.priceInBase === null ? '—' : num(h.priceInBase, 2)} ${demoBadge(h.priceIsDemo)}</td>
      <td class="text-right font-mono">${money(h.marketValue, ccy)}</td>
      <td class="text-right font-mono ${tone(h.unrealisedPnl)}">${money(h.unrealisedPnl, ccy)}<div class="text-xxs">${pct(h.unrealisedPct)}</div></td>
      <td class="text-right font-mono ${tone(h.realisedPnl)}">${money(h.realisedPnl, ccy)}</td>
      <td class="text-right font-mono ${tone(h.totalReturnPct)}">${pct(h.totalReturnPct)}</td>
      <td class="text-xxs ${h.priceStale ? 'text-yellow-400' : 'text-slate-500'}">${h.lastPriceAt ? date(h.lastPriceAt) : '—'}${h.priceStale ? html`<div>${t('stocks.priceStale')}</div>` : ''}<div>${h.priceSource || ''}</div></td>
    </tr>`));
    if (rowsEl) { drawRows(holdings); makeSortable(document.getElementById('hold-table'), holdings, drawRows); }

    const drawAlloc = (key) => {
      const a = allocation[key] || [];
      if (!a.length || !document.getElementById('alloc-chart')) return;
      renderChart('alloc-chart', doughnutChartConfig({ labels: a.map((x) => `${x.label} (${x.pct}%)`), data: a.map((x) => x.value) }), s.pricesAreDemo);
    };
    drawAlloc('byInstrument');
    document.getElementById('alloc-by').addEventListener('change', (e) => drawAlloc(e.target.value));

    renderChart('pnl-chart', barChartConfig({
      labels: holdings.map((h) => h.symbol),
      datasets: [
        { label: t('portfolio.realised'), data: holdings.map((h) => h.realisedPnl), backgroundColor: '#8b5cf6' },
        { label: t('portfolio.unrealised'), data: holdings.map((h) => h.unrealisedPnl ?? 0), backgroundColor: '#3b82f6' },
        { label: t('portfolio.dividends'), data: holdings.map((h) => h.dividends), backgroundColor: '#22c55e' },
      ],
      stacked: true,
    }), s.pricesAreDemo);

    document.getElementById('perf-range').addEventListener('change', () => loadPerformance(ccy));
    document.getElementById('cmp-select').addEventListener('change', () => loadPerformance(ccy));
  }

  function rangeFrom(range) {
    const now = new Date();
    if (range === 'ytd') return `${now.getFullYear()}-01-01`;
    if (range === '1y') { now.setFullYear(now.getFullYear() - 1); return now.toISOString().slice(0, 10); }
    if (range === '6m') { now.setMonth(now.getMonth() - 6); return now.toISOString().slice(0, 10); }
    return undefined;
  }

  /** Growth of 100 using the time-weighted (flow-adjusted) daily returns. */
  function growthIndex(series) {
    let idx = 100; const out = [];
    series.forEach((p, i) => {
      if (i > 0 && Number(series[i - 1].value) > 0) idx *= (Number(p.value) - Number(p.flow)) / Number(series[i - 1].value);
      out.push({ date: p.date, v: Math.round(idx * 100) / 100 });
    });
    return out;
  }

  async function loadPerformance(ccy) {
    const metrics = document.getElementById('perf-metrics');
    const notes = document.getElementById('perf-notes');
    if (!metrics) return;
    const from = rangeFrom(document.getElementById('perf-range').value);
    const cmp = document.getElementById('cmp-select').value;
    try {
      const [{ data: perf }, cmpRes] = await Promise.all([
        portfolios.performance(selected, { from }),
        cmp ? portfolios.performance(cmp, { from }) : Promise.resolve(null),
      ]);
      render(metrics, html`
        <div><p class="metric-label">${t('holdings.twr')} <span title="${t('hint.twr')}" class="cursor-help">ⓘ</span></p><p class="font-mono text-lg ${tone(perf.twrPct)}">${pct(perf.twrPct)}</p></div>
        <div><p class="metric-label">${t('holdings.mwr')} <span title="${t('hint.mwr')}" class="cursor-help">ⓘ</span></p><p class="font-mono text-lg ${tone(perf.mwrPct)}">${pct(perf.mwrPct)}</p></div>
        <div><p class="metric-label">${t('common.period')}</p><p class="font-mono text-sm text-slate-300">${perf.period ? `${perf.period.from} → ${perf.period.to}` : '—'}</p></div>
        ${cmpRes ? html`<div><p class="metric-label">${t('holdings.twr')} · ${list.find((p) => p.id === cmp)?.name}</p><p class="font-mono text-lg ${tone(cmpRes.data.twrPct)}">${pct(cmpRes.data.twrPct)}</p></div>` : ''}`);
      render(notes, perf.notes.map((n) => html`<p>• ${t(`perf.note.${n}`, {}, n)}</p>`));
      if (!perf.series.length) return;
      if (cmpRes) {
        const a = growthIndex(perf.series); const b = growthIndex(cmpRes.data.series);
        const labels = [...new Set([...a.map((x) => x.date), ...b.map((x) => x.date)])].sort();
        const pick = (arr) => { const m = new Map(arr.map((x) => [x.date, x.v])); let last = null; return labels.map((d) => (m.has(d) ? (last = m.get(d)) : last)); };
        renderChart('perf-chart', lineChartConfig({
          labels,
          datasets: [
            { label: list.find((p) => p.id === selected)?.name, data: pick(a), fill: false },
            { label: list.find((p) => p.id === cmp)?.name, data: pick(b), borderColor: '#f59e0b', fill: false },
          ],
          yTickFormat: (v) => v.toFixed(0),
        }), perf.pricesAreDemo || cmpRes.data.pricesAreDemo);
        notes.insertAdjacentHTML('afterbegin', String(html`<p>• ${t('holdings.compareNote')}</p>`));
      } else {
        renderChart('perf-chart', lineChartConfig({
          labels: perf.series.map((p) => p.date),
          datasets: [{ label: t('portfolio.totalValue'), data: perf.series.map((p) => Number(p.value)) }],
          yTickFormat: (v) => compactMoney(v),
        }), perf.pricesAreDemo);
      }
    } catch (err) {
      render(metrics, errorBox(err));
    }
  }

  await load();
}
