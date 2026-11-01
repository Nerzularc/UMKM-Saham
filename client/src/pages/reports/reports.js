import { reports } from '../../services/api.js';
import { appState } from '../../state/store.js';
import { t } from '../../i18n/index.js';
import {
  html, render, spinner, errorBox, emptyState, pageHeader, money, pct, tone, num, exportButtons, bindExportButtons, defaultPeriod,
} from '../../components/ui.js';
import { renderChart, barChartConfig } from '../../components/chart.js';
import { loadStructure, filterBar, canSeeFinancials, canExport } from '../franchise/shared.js';

export async function renderReports(el, params = {}) {
  const org = appState.get('currentOrg');
  const hasFranchise = org && (org.modules_enabled || []).includes('franchise');
  const tabs = [
    ...(hasFranchise && canSeeFinancials() ? [['pnl', t('report.pnl')]] : []),
    ...(hasFranchise ? [['comparison', t('report.comparison')]] : []),
    ['stocks', t('report.stocks')],
  ];
  let tab = tabs.find(([k]) => k === params.tab)?.[0] || tabs[0][0];

  render(el, html`${pageHeader(t('nav.reports'), t('report.subtitle'))}
    <div class="flex flex-wrap gap-2 mb-4" role="tablist">${tabs.map(([k, label]) => html`<button role="tab" data-tab="${k}" aria-selected="${k === tab}" class="${k === tab ? 'btn-primary' : 'btn-secondary'} btn-sm">${label}</button>`)}</div>
    <div id="rep-body"></div>`);
  el.querySelectorAll('[data-tab]').forEach((b) => b.addEventListener('click', () => {
    tab = b.dataset.tab;
    el.querySelectorAll('[data-tab]').forEach((x) => { x.className = `${x.dataset.tab === tab ? 'btn-primary' : 'btn-secondary'} btn-sm`; x.setAttribute('aria-selected', x.dataset.tab === tab); });
    show();
  }));

  async function show() {
    const body = document.getElementById('rep-body');
    render(body, spinner());
    try {
      if (tab === 'stocks') return stockReport(body);
      const structure = await loadStructure(org.org_id);
      const bar = filterBar('rep', structure, { period: tab === 'pnl' ? defaultPeriod('ytd') : defaultPeriod('mtd') });
      const dataset = tab === 'pnl' ? 'franchise-pnl' : 'outlet-comparison';
      render(body, html`${bar.html}<div class="flex justify-end mb-3">${canExport() ? exportButtons('rep-export') : ''}</div><div id="rep-content">${spinner()}</div>`);
      let filters = { ...bar.state };
      if (canExport()) bindExportButtons('rep-export', dataset, () => ({ orgId: org.org_id, ...filters }));
      const load = () => (tab === 'pnl' ? pnl(filters) : comparison(filters));
      bar.bind((f) => { filters = f; load(); });
      load();
    } catch (err) { render(body, errorBox(err)); }
  }

  async function pnl(filters) {
    const target = document.getElementById('rep-content');
    render(target, spinner());
    try {
      const res = await reports.franchisePnl({ orgId: org.org_id, ...filters });
      const rows = res.data; const tot = res.meta.total;
      if (!rows.length) return render(target, emptyState(t('franchise.noSales')));
      const line = (label, key, { bold = false, pctKey = null, neg = false } = {}) => html`<tr class="${bold ? 'font-semibold bg-surface-800/40' : ''}">
        <th scope="row" class="text-left normal-case text-sm ${bold ? 'text-slate-100' : 'text-slate-300'} font-${bold ? 'semibold' : 'normal'}">${label}</th>
        ${rows.map((m) => html`<td class="text-right font-mono ${pctKey ? '' : neg ? 'text-slate-400' : ''}">${pctKey ? pct(m[pctKey]).replace('+', '') : money(neg ? -m[key] : m[key])}</td>`)}
        <td class="text-right font-mono ${tone(pctKey ? null : tot[key])}">${pctKey ? pct(tot[pctKey]).replace('+', '') : money(neg ? -tot[key] : tot[key])}</td></tr>`;
      render(target, html`
        <div class="card mb-6"><div class="chart-container"><canvas id="rep-chart" role="img" aria-label="${t('report.pnl')}"></canvas></div></div>
        <div class="table-container"><table class="text-xs">
          <thead><tr><th>${t('report.line')}</th>${rows.map((m) => html`<th class="text-right">${m.month}</th>`)}<th class="text-right">${t('common.total')}</th></tr></thead>
          <tbody>
            ${line(t('franchise.grossSales'), 'grossSales')}
            ${line(`− ${t('sales.discounts')}`, 'discounts', { neg: true })}
            ${line(`− ${t('sales.returns')}`, 'returns', { neg: true })}
            ${line(t('franchise.netSales'), 'netSales', { bold: true })}
            ${line(`− ${t('expense.type.cogs')}`, 'cogs', { neg: true })}
            ${line(t('franchise.grossProfit'), 'grossProfit', { bold: true })}
            ${line(t('franchise.grossMargin'), null, { pctKey: 'grossMarginPct' })}
            ${line(`− ${t('franchise.opex')}`, 'operatingExpenses', { neg: true })}
            ${line(t('report.operatingProfit'), 'operatingProfit', { bold: true })}
            ${line(`− ${t('expense.type.non_operating')}`, 'nonOperatingExpenses', { neg: true })}
            ${line(`− ${t('expense.type.tax')}`, 'taxes', { neg: true })}
            ${line(t('franchise.netProfit'), 'netProfit', { bold: true })}
            ${line(t('franchise.netMargin'), null, { pctKey: 'netMarginPct' })}
          </tbody></table></div>
        <p class="text-xxs text-slate-500 mt-2">${t('report.formulaNote')}</p>`);
      renderChart('rep-chart', barChartConfig({
        labels: rows.map((m) => m.month),
        datasets: [{ label: t('franchise.netSales'), data: rows.map((m) => m.netSales) }, { label: t('franchise.grossProfit'), data: rows.map((m) => m.grossProfit) }, { label: t('franchise.netProfit'), data: rows.map((m) => m.netProfit) }],
      }), true);
    } catch (err) { render(target, errorBox(err)); }
  }

  async function comparison(filters) {
    const target = document.getElementById('rep-content');
    render(target, spinner());
    try {
      const { data, meta } = await reports.comparison({ orgId: org.org_id, ...filters });
      if (!data.length) return render(target, emptyState(t('franchise.noOutlets')));
      const fin = data[0].netProfit !== undefined;
      render(target, html`<p class="text-xs text-slate-500 mb-2">${meta.period.from} → ${meta.period.to}</p>
        <div class="table-container"><table>
        <thead><tr><th>${t('franchise.outlet')}</th><th class="text-right">${t('franchise.netSales')}</th><th class="text-right">${t('franchise.prevPeriod')}</th>
          <th class="text-right">${t('franchise.growth')}</th><th class="text-right">${t('franchise.transactions')}</th><th class="text-right">${t('franchise.atv')}</th>
          <th class="text-right">${t('franchise.achievement')}</th>${fin ? html`<th class="text-right">${t('franchise.grossMargin')}</th><th class="text-right">${t('franchise.netProfit')}</th>` : ''}</tr></thead>
        <tbody>${data.map((o) => html`<tr>
          <td>${o.name}<div class="text-xxs text-slate-500">${o.code} · ${o.brandName || ''} ${o.partialPeriod ? `· ${t('franchise.partial')}` : ''}</div></td>
          <td class="text-right font-mono">${money(o.netSales)}</td><td class="text-right font-mono text-slate-400">${money(o.previousNetSales)}</td>
          <td class="text-right font-mono ${tone(o.salesGrowthPct)}">${pct(o.salesGrowthPct)}</td><td class="text-right font-mono">${num(o.transactionCount, 0)}</td>
          <td class="text-right font-mono">${money(o.averageTransactionValue)}</td>
          <td class="text-right font-mono">${o.achievementPct === null ? '—' : `${num(o.achievementPct, 1)}%`}</td>
          ${fin ? html`<td class="text-right font-mono">${pct(o.grossMarginPct).replace('+', '')}</td><td class="text-right font-mono ${tone(o.netProfit)}">${money(o.netProfit)}</td>` : ''}</tr>`)}</tbody></table></div>`);
    } catch (err) { render(target, errorBox(err)); }
  }

  async function stockReport(body) {
    try {
      const { data } = await reports.stockOverview();
      if (!data.portfolios.length) return render(body, emptyState(t('portfolio.empty')));
      render(body, html`
        <div class="flex justify-end mb-3 gap-2"><span class="text-xs text-slate-400 self-center">${t('report.allTransactions')}</span>${exportButtons('rep-stock-export')}</div>
        <div class="table-container"><table>
        <thead><tr><th>${t('portfolio.title')}</th><th>${t('portfolio.baseCurrency')}</th><th class="text-right">${t('portfolio.totalValue')}</th>
          <th class="text-right">${t('portfolio.realised')}</th><th class="text-right">${t('portfolio.unrealised')}</th><th class="text-right">${t('portfolio.dividends')}</th>
          <th class="text-right">${t('portfolio.return')}</th><th class="text-right">%</th></tr></thead>
        <tbody>${data.portfolios.map((p) => html`<tr><td>${p.name} ${p.portfolioType === 'simulation' ? html`<span class="badge-purple">SIM</span>` : ''}</td><td>${p.baseCurrency}</td>
          <td class="text-right font-mono">${money(p.totalValue, p.baseCurrency)}</td><td class="text-right font-mono ${tone(p.realisedPnl)}">${money(p.realisedPnl, p.baseCurrency)}</td>
          <td class="text-right font-mono ${tone(p.unrealisedPnl)}">${money(p.unrealisedPnl, p.baseCurrency)}</td><td class="text-right font-mono">${money(p.dividends, p.baseCurrency)}</td>
          <td class="text-right font-mono ${tone(p.totalReturn)}">${money(p.totalReturn, p.baseCurrency)}</td><td class="text-right font-mono ${tone(p.totalReturnPct)}">${pct(p.totalReturnPct)}</td></tr>`)}</tbody></table></div>
        <p class="text-xxs text-slate-500 mt-2">${t('report.noCrossCurrency')}</p>`);
      bindExportButtons('rep-stock-export', 'stock-transactions', () => ({}));
    } catch (err) { render(body, errorBox(err)); }
  }

  show();
}
