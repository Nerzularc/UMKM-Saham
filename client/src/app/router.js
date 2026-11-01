import { appState } from '../state/store.js';
import { renderLoginPage } from '../pages/auth/login.js';
import { renderDashboard } from '../pages/dashboard/dashboard.js';
import { renderPortfolios } from '../pages/stocks/portfolios.js';
import { renderHoldings } from '../pages/stocks/holdings.js';
import { renderTransactions } from '../pages/stocks/transactions.js';
import { renderWatchlist } from '../pages/stocks/watchlist.js';
import { renderFranchiseDash } from '../pages/franchise/dashboard.js';
import { renderOutlets } from '../pages/franchise/outlets.js';
import { renderSales } from '../pages/franchise/sales.js';
import { renderExpenses } from '../pages/franchise/expenses.js';
import { renderInventory } from '../pages/franchise/inventory.js';
import { renderTargets } from '../pages/franchise/targets.js';
import { renderReports } from '../pages/reports/reports.js';
import { renderImports } from '../pages/imports/imports.js';
import { renderOrganisation } from '../pages/settings/organisation.js';
import { renderAudit } from '../pages/settings/audit.js';
import { renderAdminDash } from '../pages/settings/admin.js';
import { renderProfile } from '../pages/settings/profile.js';
import { renderShell, setActiveNav } from './shell.js';
import { t } from '../i18n/index.js';

/**
 * Route table. `org: true` routes need a selected organisation; `module`
 * hides the route when the organisation has not enabled that module.
 * These are UX conveniences only — the API enforces every permission.
 */
export const routes = {
  '#/login':               { page: renderLoginPage, public: true },
  '#/dashboard':           { page: renderDashboard },
  '#/stocks':              { page: renderPortfolios },
  '#/stocks/holdings':     { page: renderHoldings },
  '#/stocks/transactions': { page: renderTransactions },
  '#/stocks/watchlist':    { page: renderWatchlist },
  '#/franchise':           { page: renderFranchiseDash, org: true, module: 'franchise' },
  '#/franchise/outlets':   { page: renderOutlets, org: true, module: 'franchise' },
  '#/franchise/sales':     { page: renderSales, org: true, module: 'franchise' },
  '#/franchise/expenses':  { page: renderExpenses, org: true, module: 'franchise' },
  '#/franchise/inventory': { page: renderInventory, org: true, module: 'franchise' },
  '#/franchise/targets':   { page: renderTargets, org: true, module: 'franchise' },
  '#/reports':             { page: renderReports },
  '#/imports':             { page: renderImports },
  '#/organisation':        { page: renderOrganisation, org: true },
  '#/audit':               { page: renderAudit },
  '#/admin':               { page: renderAdminDash, superadmin: true },
  '#/profile':             { page: renderProfile },
};

function parseHash(hash) {
  const [path, query = ''] = (hash || '').split('?');
  return { path, params: Object.fromEntries(new URLSearchParams(query)) };
}

let navigating = false;

export function navigate(hash) {
  const { path, params } = parseHash(hash || '#/dashboard');
  const route = routes[path] ? path : '#/dashboard';
  const def = routes[route];
  const user = appState.get('user');

  if (!def.public && !user) return navigate('#/login');
  if (def.public && user) return navigate('#/dashboard');
  if (def.superadmin && !user?.isSuperadmin) return navigate('#/dashboard');

  const target = `${route}${Object.keys(params).length ? `?${new URLSearchParams(params)}` : ''}`;
  if (window.location.hash !== target) {
    navigating = true;
    window.location.hash = target;
  }
  appState.set('currentPage', route);
  document.title = `${t(`title.${route.slice(2).replace(/\//g, '.') || 'dashboard'}`, {}, route.slice(2))} · UMKM Saham`;

  if (def.public) {
    def.page(document.getElementById('app'), params);
    return;
  }

  renderShell();
  setActiveNav(route);
  const main = document.getElementById('main-content');
  main.innerHTML = '<div class="flex justify-center py-20"><div class="spinner"></div></div>';
  main.focus({ preventScroll: true });

  const org = appState.get('currentOrg');
  if (def.org && !org) {
    main.innerHTML = `<div class="alert-info"><span>ℹ</span><span>${t('org.selectFirst')}</span></div>`;
    return;
  }
  if (def.module && !(org?.modules_enabled || []).includes(def.module)) {
    main.innerHTML = `<div class="alert-warning"><span>⚠</span><span>${t('org.moduleDisabled')}</span></div>`;
    return;
  }
  Promise.resolve(def.page(main, params)).catch((err) => {
    console.error(err);
    main.innerHTML = `<div class="alert-error"><span>⚠</span><span>${t('common.error')}</span></div>`;
  });
}

window.addEventListener('hashchange', () => {
  if (navigating) { navigating = false; return; }
  navigate(window.location.hash || '#/dashboard');
});
