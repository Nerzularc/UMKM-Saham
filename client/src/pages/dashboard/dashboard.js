import { appState } from '../../state/store.js';
import { reports, franchise, integrations } from '../../services/api.js';
import { t } from '../../i18n/index.js';
import { html, render, kpi, money, pct, tone, spinner, errorBox, pageHeader, emptyState, defaultPeriod } from '../../components/ui.js';

export async function renderDashboard(el) {
  const user = appState.get('user');
  const org = appState.get('currentOrg');
  const hasFranchise = org && (org.modules_enabled || []).includes('franchise');

  render(el, html`
    ${pageHeader(t('dash.hello', { name: user.fullName.split(' ')[0] }), t('dash.subtitle'))}
    <div id="dash-status"></div>
    <section aria-labelledby="dash-stocks" class="mb-8">
      <div class="flex items-center justify-between mb-3"><h2 id="dash-stocks">${t('dash.investments')}</h2><a href="#/stocks/holdings" class="text-sm">${t('common.viewDetails')} →</a></div>
      <div id="dash-stocks-body">${spinner()}</div>
    </section>
    ${hasFranchise ? html`<section aria-labelledby="dash-fr">
      <div class="flex items-center justify-between mb-3"><h2 id="dash-fr">${t('dash.franchiseMtd', { org: org.org_name })}</h2><a href="#/franchise" class="text-sm">${t('common.viewDetails')} →</a></div>
      <div id="dash-fr-body">${spinner()}</div></section>` : ''}`);

  integrations.status().then(({ data }) => {
    if (!data.marketData.live) {
      render(document.getElementById('dash-status'), html`<div class="alert-warning mb-6"><span aria-hidden="true">ⓘ</span>
        <span>${t('dash.demoPrices')} </span></div>`);
    }
  }).catch(() => {});

  try {
    const { data } = await reports.stockOverview();
    const body = document.getElementById('dash-stocks-body');
    if (!data.portfolios.length) {
      render(body, html`<div class="card">${emptyState(t('portfolio.empty'), t('portfolio.emptyDesc'), '📈')}<div class="text-center"><a href="#/stocks" class="btn-primary">${t('portfolio.new')}</a></div></div>`);
    } else {
      render(body, html`
        <div class="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4 mb-4">
          ${data.totalsByCurrency.map((c) => kpi(t('dash.totalValue', { ccy: c.baseCurrency }), money(c.totalValue, c.baseCurrency), { sub: `${t('portfolio.return')}: ${money(c.totalReturn, c.baseCurrency)}`, subTone: tone(c.totalReturn) }))}
        </div>
        <div class="table-container"><table>
          <thead><tr><th>${t('common.name')}</th><th class="text-right">${t('portfolio.totalValue')}</th><th class="text-right">${t('portfolio.unrealised')}</th><th class="text-right">${t('portfolio.return')}</th><th></th></tr></thead>
          <tbody>${data.portfolios.map((p) => html`<tr>
            <td><a href="#/stocks/holdings?portfolio=${p.id}">${p.name}</a> ${p.portfolioType === 'simulation' ? html`<span class="badge-purple">${t('portfolio.simulation')}</span>` : ''}</td>
            <td class="text-right font-mono">${money(p.totalValue, p.baseCurrency)}</td>
            <td class="text-right font-mono ${tone(p.unrealisedPnl)}">${money(p.unrealisedPnl, p.baseCurrency)}</td>
            <td class="text-right font-mono ${tone(p.totalReturnPct)}">${pct(p.totalReturnPct)}</td>
            <td>${p.pricesAreDemo ? html`<span class="badge-yellow">DEMO</span>` : ''}</td></tr>`)}</tbody>
        </table></div>`);
    }
  } catch (err) {
    render(document.getElementById('dash-stocks-body'), errorBox(err));
  }

  if (hasFranchise) {
    try {
      const { data } = await franchise.dashboard({ orgId: org.org_id, ...defaultPeriod('mtd') });
      const s = data.summary;
      render(document.getElementById('dash-fr-body'), html`<div class="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
        ${kpi(t('franchise.netSales'), money(s.netSales), { sub: s.salesGrowthPct === null ? '' : `${pct(s.salesGrowthPct)} ${t('common.vsPrev')}`, subTone: tone(s.salesGrowthPct) })}
        ${data.canSeeFinancials ? kpi(t('franchise.netProfit'), money(s.netProfit), { sub: `${t('franchise.netMargin')} ${pct(s.netMarginPct)}`, subTone: tone(s.netProfit) }) : kpi(t('franchise.transactions'), s.transactionCount.toLocaleString())}
        ${kpi(t('franchise.achievement'), s.achievementPct === null ? '—' : pct(s.achievementPct).replace('+', ''), { sub: s.target ? `${t('franchise.target')} ${money(s.target)}` : t('franchise.noTarget') })}
        ${kpi(t('franchise.alerts'), `${s.underperformingCount} / ${s.lowStockCount}`, { sub: t('franchise.alertsSub') })}
      </div>`);
    } catch (err) {
      render(document.getElementById('dash-fr-body'), errorBox(err));
    }
  }
}
