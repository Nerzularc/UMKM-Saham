import { appState } from '../state/store.js';
import { t, setLocale, getLocale } from '../i18n/index.js';
import { auth } from '../services/api.js';
import { html, raw, render, toast as uiToast } from '../components/ui.js';

const ROLE_LABEL = { org_owner: 'role.org_owner', manager: 'role.manager', staff: 'role.staff' };

export function showToast(message, type = 'success', duration) {
  uiToast(message, type, duration);
}

function can(perm) {
  const org = appState.get('currentOrg');
  const matrix = { org_owner: ['manage', 'members', 'export', 'financials'], manager: ['export', 'financials'], staff: [] };
  return !!org && (matrix[org.role_name] || []).includes(perm);
}
export { can };

/** Render the application frame once; subsequent calls are no-ops unless forced. */
export function renderShell(force = false) {
  const app = document.getElementById('app');
  if (!force && document.getElementById('main-content')) return;
  const user = appState.get('user');
  if (!user) return;

  render(app, html`
    <a href="#main-content" class="sr-only focus:not-sr-only focus:absolute focus:z-50 focus:p-2 focus:bg-brand-700">${t('a11y.skip')}</a>
    <div class="flex h-screen overflow-hidden">
      ${sidebar()}
      <div class="flex-1 flex flex-col min-w-0 overflow-hidden">
        ${topbar()}
        <main id="main-content" tabindex="-1" class="flex-1 overflow-y-auto p-4 md:p-6 fade-enter outline-none"></main>
      </div>
    </div>
    <div id="sidebar-overlay" class="fixed inset-0 bg-black/60 z-30 hidden md:hidden"></div>
    <div id="toast-container" class="fixed bottom-4 right-4 z-50 flex flex-col gap-2" aria-live="polite"></div>`);
  bindShellEvents();
}

function sidebar() {
  const user = appState.get('user');
  const org = appState.get('currentOrg');
  const modules = org?.modules_enabled || [];
  const item = (hash, icon, label) => html`<a href="${hash}" data-nav="${hash}" class="nav-item">${icon}<span>${label}</span></a>`;
  const section = (label) => html`<p class="nav-section">${label}</p>`;

  return html`
  <aside id="sidebar" class="flex flex-col bg-surface-900 border-r border-slate-800 h-full overflow-y-auto" aria-label="${t('a11y.mainNav')}">
    <div class="px-4 py-5 border-b border-slate-800 flex items-center gap-3">
      <div class="w-8 h-8 bg-brand-600 rounded-lg flex items-center justify-center text-white font-bold text-sm" aria-hidden="true">US</div>
      <div><p class="text-sm font-semibold text-slate-100">UMKM Saham</p><p class="text-xxs text-slate-500">${t('app.tagline')}</p></div>
    </div>
    ${import.meta.env.VITE_DEMO_MODE !== 'false' ? html`<div class="mx-3 mt-3 demo-banner"><span aria-hidden="true">⚠</span><span>${t('common.demoShort')}</span></div>` : ''}
    <nav class="flex-1 px-2 py-3 space-y-0.5">
      ${item('#/dashboard', icons.dashboard, t('nav.dashboard'))}
      ${section(t('nav.stocks'))}
      ${item('#/stocks', icons.portfolio, t('nav.portfolios'))}
      ${item('#/stocks/holdings', icons.chart, t('nav.holdings'))}
      ${item('#/stocks/transactions', icons.tx, t('nav.transactions'))}
      ${item('#/stocks/watchlist', icons.star, t('nav.watchlist'))}
      ${org && modules.includes('franchise') ? html`
        ${section(t('nav.franchise'))}
        ${item('#/franchise', icons.franchise, t('nav.franchiseDashboard'))}
        ${item('#/franchise/outlets', icons.pin, t('nav.outlets'))}
        ${item('#/franchise/sales', icons.sales, t('nav.sales'))}
        ${item('#/franchise/expenses', icons.expense, t('nav.expenses'))}
        ${item('#/franchise/inventory', icons.box, t('nav.inventory'))}
        ${item('#/franchise/targets', icons.target, t('nav.targets'))}` : ''}
      ${section(t('nav.reportsData'))}
      ${item('#/reports', icons.report, t('nav.reports'))}
      ${item('#/imports', icons.upload, t('nav.imports'))}
      ${section(t('nav.account'))}
      ${org ? item('#/organisation', icons.org, t('nav.organisation')) : ''}
      ${item('#/audit', icons.shield, t('nav.audit'))}
      ${item('#/profile', icons.user, t('nav.profile'))}
      ${user.isSuperadmin ? html`${section(t('nav.admin'))}${item('#/admin', icons.admin, t('nav.platform'))}` : ''}
    </nav>
    <div class="p-3 border-t border-slate-800">
      <a href="#/profile" class="flex items-center gap-3 p-2 rounded-lg hover:bg-surface-800 no-underline">
        <div class="w-8 h-8 rounded-full bg-brand-700 flex items-center justify-center text-sm font-semibold text-white shrink-0" aria-hidden="true">${(user.fullName || 'U')[0].toUpperCase()}</div>
        <div class="flex-1 min-w-0"><p class="text-xs font-medium text-slate-200 truncate">${user.fullName}</p><p class="text-xxs text-slate-500 truncate">${user.email}</p></div>
      </a>
    </div>
  </aside>`;
}

function topbar() {
  const org = appState.get('currentOrg');
  const memberships = appState.get('memberships') || [];
  return html`
  <header class="flex items-center justify-between gap-3 px-4 md:px-6 py-3 bg-surface-900 border-b border-slate-800 shrink-0">
    <div class="flex items-center gap-3 min-w-0">
      <button id="menu-btn" class="md:hidden btn-secondary btn-sm p-2" aria-label="${t('a11y.menu')}" aria-controls="sidebar">${icons.menu}</button>
      <label for="org-selector" class="sr-only">${t('org.context')}</label>
      <select id="org-selector" class="bg-surface-800 border border-slate-700 text-slate-200 text-xs rounded-lg px-2 py-1.5 max-w-[60vw]">
        <option value="">${t('org.personal')}</option>
        ${memberships.map((m) => html`<option value="${m.org_id}" ${org?.org_id === m.org_id ? 'selected' : ''}>${m.org_name} · ${t(ROLE_LABEL[m.role_name] || m.role_name)}</option>`)}
      </select>
    </div>
    <div class="flex items-center gap-2">
      <button id="locale-btn" class="btn-secondary btn-sm text-xs" aria-label="${t('a11y.language')}">${getLocale() === 'id' ? 'ID' : 'EN'}</button>
      <button id="logout-btn" class="btn-secondary btn-sm text-xs">${t('auth.logout')}</button>
    </div>
  </header>`;
}

export function setActiveNav(route) {
  document.querySelectorAll('[data-nav]').forEach((a) => {
    const active = a.dataset.nav === route;
    a.classList.toggle('active', active);
    if (active) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  });
  document.getElementById('sidebar')?.classList.remove('open');
  document.getElementById('sidebar-overlay')?.classList.add('hidden');
}

async function rerender() {
  const { navigate } = await import('./router.js');
  renderShell(true);
  navigate(window.location.hash || '#/dashboard');
}

function bindShellEvents() {
  const sidebarEl = document.getElementById('sidebar');
  const overlay = document.getElementById('sidebar-overlay');
  document.getElementById('menu-btn')?.addEventListener('click', () => {
    sidebarEl.classList.toggle('open');
    overlay.classList.toggle('hidden');
  });
  overlay?.addEventListener('click', () => { sidebarEl.classList.remove('open'); overlay.classList.add('hidden'); });

  document.getElementById('org-selector')?.addEventListener('change', (e) => {
    const org = (appState.get('memberships') || []).find((m) => m.org_id === e.target.value) || null;
    appState.set('currentOrg', org);
    try { localStorage.setItem('currentOrg', org?.org_id || ''); } catch { /* storage unavailable */ }
    rerender();
  });

  document.getElementById('locale-btn')?.addEventListener('click', () => {
    setLocale(getLocale() === 'id' ? 'en' : 'id');
    rerender();
  });

  document.getElementById('logout-btn')?.addEventListener('click', async () => {
    try { await auth.logout(); } catch { /* session may already be gone */ }
    window.dispatchEvent(new CustomEvent('auth:logout'));
  });
}

// ── Icons (inline SVG, decorative) ───────────────────────────────────────────
const svg = (p) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" class="w-4 h-4 shrink-0" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${p}</svg>`;
const I = (p) => raw(svg(p));

export const icons = {
  dashboard: I('<rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/>'),
  portfolio: I('<path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/>'),
  chart: I('<polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>'),
  tx: I('<path d="M7 7h11l-3-3M17 17H6l3 3"/>'),
  star: I('<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>'),
  franchise: I('<path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/>'),
  pin: I('<path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/>'),
  sales: I('<line x1="12" y1="20" x2="12" y2="10"/><line x1="18" y1="20" x2="18" y2="4"/><line x1="6" y1="20" x2="6" y2="16"/>'),
  expense: I('<rect x="2" y="5" width="20" height="14" rx="2"/><line x1="2" y1="10" x2="22" y2="10"/>'),
  box: I('<path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/>'),
  target: I('<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1"/>'),
  report: I('<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/>'),
  upload: I('<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>'),
  org: I('<path d="M3 21h18M5 21V7l7-4 7 4v14M9 9h1M14 9h1M9 13h1M14 13h1M9 17h1M14 17h1"/>'),
  shield: I('<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>'),
  user: I('<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>'),
  admin: I('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>'),
  menu: I('<line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="18" x2="21" y2="18"/>'),
};
