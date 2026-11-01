import { franchise } from '../../services/api.js';
import { t } from '../../i18n/index.js';
import {
  html, render, spinner, errorBox, emptyState, pageHeader, kpi, money, num, pct, tone, compactMoney,
  exportButtons, bindExportButtons, makeSortable, defaultPeriod,
} from '../../components/ui.js';
import { renderChart, lineChartConfig, barChartConfig } from '../../components/chart.js';
import { loadStructure, filterBar, currentOrg, canExport } from './shared.js';

export async function renderFranchiseDash(el) {
  const org = currentOrg();
  render(el, spinner());
  let structure;
  try { structure = await loadStructure(org.org_id); } catch (err) { return render(el, errorBox(err)); }
  const bar = filterBar('fd', structure, { period: defaultPeriod('mtd') });

  render(el, html`
    ${pageHeader(t('nav.franchiseDashboard'), html`${org.org_name} · <span id="fd-scope"></span>`, canExport() ? exportButtons('fd-export') : '')}
    ${bar.html}
    <div id="fd-body">${spinner()}</div>`);

  let filters = { ...bar.state };
  bar.bind((f) => { filters = f; load(); });
  if (canExport()) bindExportButtons('fd-export', 'outlet-comparison', () => ({ orgId: org.org_id, ...filters }));

  async function load() {
    const body = document.getElementById('fd-body');
    render(body, spinner());
    try {
      const params = { orgId: org.org_id, ...filters };
      const sixMonths = defaultPeriod('last6m');
      const [{ data }, trends] = await Promise.all([
        franchise.dashboard(params),
        franchise.trends({ ...params, from: sixMonths.from, to: filters.to }),
      ]);
      draw(body, data, trends.data);
    } catch (err) { render(body, errorBox(err)); }
  }

  function draw(body, d, trends) {
    const s = d.summary;
    const fin = d.canSeeFinancials;
    document.getElementById('fd-scope').textContent = d.scope === 'organisation' ? t('franchise.scopeOrg') : t('franchise.scopeAssigned', { n: d.outlets.length });
    render(body, html`
      <p class="text-xs text-slate-500 mb-3">${t('common.period')}: ${d.period.from} → ${d.period.to} · ${t('franchise.comparedTo')} ${d.previousPeriod.from} → ${d.previousPeriod.to}</p>
      <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        ${kpi(t('franchise.netSales'), money(s.netSales), { sub: s.salesGrowthPct === null ? t('franchise.noPrev') : `${pct(s.salesGrowthPct)} ${t('common.vsPrev')}`, subTone: tone(s.salesGrowthPct), hint: t('hint.netSales') })}
        ${fin ? kpi(t('franchise.grossProfit'), money(s.grossProfit), { sub: `${t('franchise.grossMargin')} ${pct(s.grossMarginPct).replace('+', '')}`, hint: t('hint.grossProfit') })
          : kpi(t('franchise.transactions'), num(s.transactionCount, 0))}
        ${fin ? kpi(t('franchise.netProfit'), money(s.netProfit), { sub: `${t('franchise.netMargin')} ${pct(s.netMarginPct)}`, subTone: tone(s.netProfit), hint: t('hint.netProfit') })
          : kpi(t('franchise.atv'), money(s.averageTransactionValue), { hint: t('hint.atv') })}
        ${kpi(t('franchise.achievement'), s.achievementPct === null ? '—' : `${num(s.achievementPct, 1)}%`, { sub: s.target ? `${t('franchise.target')} ${money(s.target)}` : t('franchise.noTarget'), subTone: s.achievementPct !== null && s.achievementPct < 80 ? 'tag-down' : '', hint: t('hint.achievement') })}
      </div>
      ${fin ? html`<div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        ${kpi(t('franchise.transactions'), num(s.transactionCount, 0))}
        ${kpi(t('franchise.atv'), money(s.averageTransactionValue), { hint: t('hint.atv') })}
        ${kpi(t('franchise.opex'), money(s.operatingExpenses))}
        ${kpi(t('franchise.alerts'), `${s.underperformingCount} / ${s.lowStockCount}`, { sub: t('franchise.alertsSub') })}
      </div>` : ''}

      <div class="grid grid-cols-1 xl:grid-cols-3 gap-6 mb-6">
        <section class="card xl:col-span-2"><div class="card-header"><h3>${t('franchise.dailySales')}</h3></div>
          ${d.dailySales.length ? html`<div class="chart-container"><canvas id="fd-daily" role="img" aria-label="${t('franchise.dailySales')}"></canvas></div>` : emptyState(t('franchise.noSales'))}</section>
        <section class="card"><div class="card-header"><h3>${t('franchise.lowStock')}</h3><a href="#/franchise/inventory" class="text-xs">${t('common.viewAll')}</a></div>
          ${d.lowStock.length ? html`<ul class="divide-y divide-slate-800 text-sm max-h-64 overflow-y-auto">${d.lowStock.map((x) => html`<li class="py-2 flex justify-between gap-2">
            <span><span class="text-slate-200">${x.product_name}</span><div class="text-xxs text-slate-500">${x.outlet_name}</div></span>
            <span class="font-mono text-red-300 whitespace-nowrap">${num(x.quantity, 0)} / ${x.reorder_level} ${x.unit}</span></li>`)}</ul>` : emptyState(t('franchise.stockOk'), '', '✅')}</section>
      </div>

      <section class="mb-6" aria-labelledby="cmp-title">
        <div class="flex items-center justify-between mb-3"><h3 id="cmp-title">${t('franchise.outletComparison')}</h3>
          <span class="text-xxs text-slate-500">${t('franchise.underperformingRule')}</span></div>
        <div class="table-container"><table id="fd-table">
          <thead><tr><th data-sort="name">${t('franchise.outlet')}</th><th data-sort="netSales" class="text-right">${t('franchise.netSales')}</th>
            <th data-sort="salesGrowthPct" class="text-right">${t('franchise.growth')}</th>
            <th data-sort="achievementPct" class="text-right">${t('franchise.achievement')}</th>
            <th data-sort="averageTransactionValue" class="text-right">${t('franchise.atv')}</th>
            ${fin ? html`<th data-sort="grossMarginPct" class="text-right">${t('franchise.grossMargin')}</th><th data-sort="netProfit" class="text-right">${t('franchise.netProfit')}</th>` : ''}
            <th>${t('common.status')}</th></tr></thead>
          <tbody id="fd-rows"></tbody></table></div>
      </section>

      <div class="grid grid-cols-1 ${fin ? 'xl:grid-cols-2' : ''} gap-6">
        <section class="card"><div class="card-header"><h3>${t('franchise.monthlyTrend')}</h3></div>
          <div class="chart-container"><canvas id="fd-trend" role="img" aria-label="${t('franchise.monthlyTrend')}"></canvas></div></section>
        ${fin ? html`<section class="card"><div class="card-header"><h3>${t('franchise.expenseTrend')}</h3></div>
          <div class="chart-container"><canvas id="fd-exp" role="img" aria-label="${t('franchise.expenseTrend')}"></canvas></div></section>` : ''}
      </div>`);

    const rowsEl = document.getElementById('fd-rows');
    const drawRows = (rows) => render(rowsEl, rows.length ? rows.map((o) => html`<tr>
      <td><div class="text-slate-100">${o.name}</div><div class="text-xxs text-slate-500">${o.code} · ${o.brandName || ''} · ${o.regionName || ''}</div></td>
      <td class="text-right font-mono">${money(o.netSales)}</td>
      <td class="text-right font-mono ${tone(o.salesGrowthPct)}">${pct(o.salesGrowthPct)}</td>
      <td class="text-right font-mono ${o.achievementPct !== null && o.achievementPct < 80 ? 'tag-down' : ''}">${o.achievementPct === null ? '—' : `${num(o.achievementPct, 1)}%`}
        ${o.achievementPct !== null ? html`<div class="h-1 bg-slate-800 rounded mt-1" aria-hidden="true"><div class="h-1 rounded ${o.achievementPct >= 100 ? 'bg-green-500' : o.achievementPct >= 80 ? 'bg-yellow-500' : 'bg-red-500'}" style="width:${Math.min(100, o.achievementPct)}%"></div></div>` : ''}</td>
      <td class="text-right font-mono">${money(o.averageTransactionValue)}</td>
      ${fin ? html`<td class="text-right font-mono">${pct(o.grossMarginPct).replace('+', '')}</td><td class="text-right font-mono ${tone(o.netProfit)}">${money(o.netProfit)}</td>` : ''}
      <td class="space-x-1">${o.underperforming ? html`<span class="badge-red">${t('franchise.underperforming')}</span>` : html`<span class="badge-green">OK</span>`}
        ${o.partialPeriod ? html`<span class="badge-gray" title="${t('franchise.partialHint')}">${t('franchise.partial')}</span>` : ''}
        ${o.status !== 'active' ? html`<span class="badge-yellow">${t(`outlet.status.${o.status}`)}</span>` : ''}</td>
    </tr>`) : html`<tr><td colspan="8">${emptyState(t('franchise.noOutlets'))}</td></tr>`);
    drawRows(d.outlets);
    makeSortable(document.getElementById('fd-table'), d.outlets, drawRows);

    if (d.dailySales.length) {
      renderChart('fd-daily', lineChartConfig({
        labels: d.dailySales.map((x) => x.date.slice(5)),
        datasets: [{ label: t('franchise.netSales'), data: d.dailySales.map((x) => x.netSales) }],
        yTickFormat: compactMoney,
      }), true);
    }
    const months = trends.months || [];
    renderChart('fd-trend', barChartConfig({
      labels: months.map((m) => m.month),
      datasets: fin
        ? [{ label: t('franchise.netSales'), data: months.map((m) => m.netSales) }, { label: t('franchise.grossProfit'), data: months.map((m) => m.grossProfit) }, { label: t('franchise.netProfit'), data: months.map((m) => m.netProfit) }]
        : [{ label: t('franchise.netSales'), data: months.map((m) => m.netSales) }],
    }), true);
    if (fin && trends.expenses) {
      const cats = [...new Set(trends.expenses.map((e) => e.category))];
      const ms = [...new Set(trends.expenses.map((e) => e.month))];
      renderChart('fd-exp', barChartConfig({
        labels: ms,
        datasets: cats.map((c) => ({ label: c, data: ms.map((m) => trends.expenses.find((e) => e.month === m && e.category === c)?.amount || 0) })),
        stacked: true,
      }), true);
    }
  }
  await load();
}
