import { auditApi } from '../../services/api.js';
import { appState } from '../../state/store.js';
import { t } from '../../i18n/index.js';
import { html, render, spinner, errorBox, emptyState, pageHeader, pager, bindPager, exportButtons, bindExportButtons, raw } from '../../components/ui.js';

export async function renderAudit(el) {
  const org = appState.get('currentOrg');
  const orgAudit = org && ['org_owner', 'manager'].includes(org.role_name);
  const state = { scope: orgAudit ? 'org' : 'me', action: '', from: '', to: '', page: 1 };
  render(el, html`${pageHeader(t('nav.audit'), t('audit.subtitle'), orgAudit ? exportButtons('aud-export') : '')}
    <div class="card mb-4 flex flex-wrap gap-3 items-end">
      <div><label class="form-label" for="a-scope">${t('audit.scope')}</label><select id="a-scope" class="form-select py-1.5">
        ${orgAudit ? html`<option value="org">${org.org_name}</option>` : ''}<option value="me">${t('audit.mine')}</option></select></div>
      <div><label class="form-label" for="a-action">${t('audit.action')}</label><select id="a-action" class="form-select py-1.5">
        <option value="">${t('common.all')}</option>${['auth', 'transaction', 'sales', 'expense', 'inventory', 'member', 'import', 'export', 'approval', 'organisation', 'outlet', 'target'].map((x) => html`<option value="${x}">${x}.*</option>`)}</select></div>
      <div><label class="form-label" for="a-from">${t('common.from')}</label><input type="date" id="a-from" class="form-input py-1.5"></div>
      <div><label class="form-label" for="a-to">${t('common.to')}</label><input type="date" id="a-to" class="form-input py-1.5"></div>
    </div>
    <p class="text-xxs text-slate-500 mb-3">${t('audit.immutable')}</p>
    <div id="a-body">${spinner()}</div>`);
  if (orgAudit) bindExportButtons('aud-export', 'audit', () => ({ orgId: org.org_id, from: state.from, to: state.to }));
  const bind = (id, key) => document.getElementById(id).addEventListener('change', (e) => { state[key] = e.target.value; state.page = 1; load(); });
  bind('a-scope', 'scope'); bind('a-action', 'action'); bind('a-from', 'from'); bind('a-to', 'to');

  async function load() {
    const target = document.getElementById('a-body');
    render(target, spinner());
    try {
      const res = await auditApi.list({ orgId: state.scope === 'org' ? org.org_id : '', action: state.action, from: state.from, to: state.to, page: state.page, limit: 50 });
      if (!res.data.length) return render(target, emptyState(t('audit.empty')));
      const diff = (a) => {
        if (!a.old_values || !a.new_values) return '';
        const keys = Object.keys(a.new_values).filter((k) => JSON.stringify(a.old_values[k]) !== JSON.stringify(a.new_values[k]) && !['updated_at', 'created_at'].includes(k));
        return keys.slice(0, 6).map((k) => `${k}: ${a.old_values[k] ?? '∅'} → ${a.new_values[k] ?? '∅'}`).join(' · ');
      };
      render(target, html`<div class="table-container"><table class="text-xs">
        <thead><tr><th>${t('audit.time')}</th><th>${t('audit.actor')}</th><th>${t('audit.action')}</th><th>${t('audit.resource')}</th><th>${t('audit.details')}</th></tr></thead>
        <tbody>${res.data.map((a) => html`<tr><td class="whitespace-nowrap">${new Date(a.created_at).toLocaleString()}</td><td>${a.actor_email || '—'}</td>
          <td><span class="${a.action.includes('failed') || a.action.includes('delete') ? 'badge-red' : 'badge-gray'}">${a.action}</span></td>
          <td class="font-mono">${a.resource_type}${a.resource_id ? html`<div class="text-slate-500">${a.resource_id.slice(0, 8)}</div>` : ''}</td>
          <td class="text-slate-400 break-all max-w-md">${diff(a)}${a.metadata?.reason ? html`<div>${t('common.reason')}: ${a.metadata.reason}</div>` : ''}</td></tr>`)}</tbody></table></div>${pager(res.meta)}`);
      bindPager(target, (p) => { state.page = p; load(); });
    } catch (err) { render(target, errorBox(err)); }
  }
  void raw;
  load();
}
