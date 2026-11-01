import { admin, integrations } from '../../services/api.js';
import { t } from '../../i18n/index.js';
import { html, render, spinner, errorBox, pageHeader, kpi, num, date, toast, confirmAction } from '../../components/ui.js';

export async function renderAdminDash(el) {
  render(el, html`${pageHeader(t('nav.platform'), t('admin.subtitle'))}
    <div class="alert-info mb-4"><span>ⓘ</span><span>${t('admin.privacy')}</span></div>
    <div id="ad-stats" class="mb-6">${spinner()}</div>
    <div class="grid grid-cols-1 xl:grid-cols-2 gap-6 mb-6">
      <section class="card"><div class="card-header"><h3>${t('admin.integrations')}</h3><div class="flex gap-2"><button id="sync-prices" class="btn-secondary btn-sm">${t('admin.syncPrices')}</button><button id="sync-fx" class="btn-secondary btn-sm">${t('admin.syncFx')}</button></div></div><div id="ad-int">${spinner()}</div></section>
      <section class="card"><div class="card-header"><h3>${t('admin.settings')}</h3></div><div id="ad-settings">${spinner()}</div></section>
    </div>
    <section class="mb-6"><h3 class="mb-3">${t('admin.organisations')}</h3><div id="ad-orgs">${spinner()}</div></section>
    <section class="mb-6"><div class="flex justify-between items-end mb-3"><h3>${t('admin.users')}</h3><input id="ad-q" class="form-input py-1.5 max-w-xs" placeholder="${t('common.search')}…" aria-label="${t('common.search')}"></div><div id="ad-users">${spinner()}</div></section>
    <section class="mb-6"><h3 class="mb-3">${t('admin.jobs')}</h3><div id="ad-jobs">${spinner()}</div></section>
    <section><h3 class="mb-3">${t('admin.security')}</h3><div id="ad-sec">${spinner()}</div></section>`);

  const safe = async (id, fn) => { try { await fn(document.getElementById(id)); } catch (err) { render(document.getElementById(id), errorBox(err)); } };

  safe('ad-stats', async (box) => {
    const { data: s } = await admin.stats();
    render(box, html`<div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
      ${kpi(t('admin.users'), num(s.users, 0), { sub: `${num(s.active_users_30d, 0)} ${t('admin.active30')} · ${num(s.inactive_users, 0)} ${t('common.inactive')}` })}
      ${kpi(t('admin.organisations'), num(s.organisations, 0), { sub: `${num(s.suspended_organisations, 0)} ${t('admin.suspended')}` })}
      ${kpi(t('admin.sessions'), num(s.active_sessions, 0), { sub: `${num(s.portfolios, 0)} ${t('nav.portfolios')} · ${num(s.outlets, 0)} ${t('nav.outlets')}` })}
      ${kpi(t('admin.alerts'), `${s.failed_logins_24h} / ${s.failed_imports_7d} / ${s.failed_sync_jobs_7d}`, { sub: t('admin.alertsSub'), subTone: s.failed_logins_24h > 10 ? 'tag-down' : '' })}
    </div>`);
  });

  const loadInt = () => safe('ad-int', async (box) => {
    const { data } = await integrations.status();
    render(box, html`<dl class="text-sm space-y-2">
      <div><dt class="metric-label">${t('int.marketData')}</dt><dd>${data.marketData.provider} · ${data.marketData.live ? html`<span class="badge-green">${t('int.live')}</span>` : html`<span class="badge-yellow">${t('int.demo')}</span>`}
        <div class="text-xxs text-slate-500">${data.marketData.description}</div>
        <div class="text-xxs text-slate-500">${t('admin.instrumentPrices', { demo: data.marketData.demo_instruments, live: data.marketData.live_instruments })}</div></dd></div>
      <div><dt class="metric-label">${t('int.currency')}</dt><dd>${data.currency.provider} · ${data.currency.configured ? html`<span class="badge-green">${t('int.live')}</span>` : html`<span class="badge-yellow">${t('int.demo')}</span>`}</dd></div>
      <div><dt class="metric-label">${t('int.broker')}</dt><dd class="text-xs">${data.brokers.adapters.map((a) => a.label || a.name).join(', ')} · ${t('admin.orderExecution')}: ${data.brokers.orderExecutionAvailable ? t('common.yes') : t('common.no')}</dd></div>
    </dl>`);
  });
  loadInt();
  for (const [id, fn] of [['sync-prices', integrations.syncPrices], ['sync-fx', integrations.syncFx]]) {
    document.getElementById(id).addEventListener('click', async (e) => {
      e.target.disabled = true;
      try { const { data } = await fn(); toast(data.skipped ? data.reason : `${data.status}: ${data.synced ?? 0}`, data.skipped ? 'info' : 'success', 7000); loadInt(); loadJobs(); } catch (err) { toast(err.message, 'error'); } finally { e.target.disabled = false; }
    });
  }

  safe('ad-settings', async (box) => {
    const { data } = await admin.settings();
    const reg = data.settings.find((s) => s.key === 'registration_enabled')?.value !== false;
    render(box, html`<label class="flex items-center gap-2 text-sm"><input type="checkbox" id="set-reg" class="rounded" ${reg ? 'checked' : ''}> ${t('admin.registration')}</label>
      <h4 class="mt-4 mb-2 text-sm">${t('admin.roleMatrix')}</h4>
      <div class="text-xxs space-y-1">${Object.entries(data.roles).map(([r, perms]) => html`<p><span class="badge-blue">${t(`role.${r}`)}</span> <span class="text-slate-400">${perms.join(', ')}</span></p>`)}</div>`);
    document.getElementById('set-reg').addEventListener('change', async (e) => {
      try { await admin.setSetting('registration_enabled', e.target.checked); toast(t('common.saved')); } catch (err) { toast(err.message, 'error'); }
    });
  });

  const loadOrgs = () => safe('ad-orgs', async (box) => {
    const { data } = await admin.orgs();
    render(box, html`<div class="table-container"><table class="text-sm"><thead><tr><th>${t('common.name')}</th><th>${t('admin.owner')}</th><th>${t('org.modules')}</th><th class="text-right">${t('org.members')}</th><th class="text-right">${t('nav.outlets')}</th><th>${t('common.status')}</th><th></th></tr></thead>
      <tbody>${data.map((o) => html`<tr><td>${o.name}<div class="text-xxs text-slate-500">${o.slug}</div></td><td class="text-xs">${o.owner_email}</td><td class="text-xs">${(o.modules_enabled || []).join(', ')}</td>
        <td class="text-right">${o.member_count}</td><td class="text-right">${o.outlet_count}</td>
        <td>${o.is_active ? html`<span class="badge-green">${t('common.active')}</span>` : html`<span class="badge-red">${t('admin.suspended')}</span>`}</td>
        <td><button class="btn-secondary btn-sm" data-org="${o.id}" data-active="${o.is_active}">${o.is_active ? t('admin.suspend') : t('org.reactivate')}</button></td></tr>`)}</tbody></table></div>`);
    box.querySelectorAll('[data-org]').forEach((b) => b.addEventListener('click', async () => {
      const activate = b.dataset.active !== 'true';
      if (!activate && !(await confirmAction({ title: t('admin.suspend'), message: t('admin.suspendOrgMsg') }))) return;
      try { await admin.setOrg(b.dataset.org, { isActive: activate }); loadOrgs(); } catch (err) { toast(err.message, 'error'); }
    }));
  });
  loadOrgs();

  const loadUsers = (q = '') => safe('ad-users', async (box) => {
    const { data } = await admin.users({ q, limit: 50 });
    render(box, html`<div class="table-container"><table class="text-sm"><thead><tr><th>${t('common.name')}</th><th>2FA</th><th class="text-right">${t('admin.orgs')}</th><th>${t('admin.lastLogin')}</th><th>${t('common.status')}</th><th></th></tr></thead>
      <tbody>${data.map((u) => html`<tr><td>${u.full_name} ${u.is_superadmin ? html`<span class="badge-purple">SA</span>` : ''}<div class="text-xxs text-slate-500">${u.email}</div></td>
        <td>${u.two_factor_enabled ? '✓' : '—'}</td><td class="text-right">${u.org_count}</td><td class="text-xs">${u.last_login_at ? date(u.last_login_at) : '—'}</td>
        <td>${u.is_active ? html`<span class="badge-green">${t('common.active')}</span>` : html`<span class="badge-red">${t('admin.suspended')}</span>`}</td>
        <td><button class="btn-secondary btn-sm" data-user="${u.id}" data-active="${u.is_active}">${u.is_active ? t('admin.suspend') : t('org.reactivate')}</button></td></tr>`)}</tbody></table></div>`);
    box.querySelectorAll('[data-user]').forEach((b) => b.addEventListener('click', async () => {
      const activate = b.dataset.active !== 'true';
      if (!activate && !(await confirmAction({ title: t('admin.suspend'), message: t('admin.suspendUserMsg') }))) return;
      try { await admin.setUser(b.dataset.user, { isActive: activate }); loadUsers(document.getElementById('ad-q').value); } catch (err) { toast(err.message, 'error'); }
    }));
  });
  loadUsers();
  let timer;
  document.getElementById('ad-q').addEventListener('input', (e) => { clearTimeout(timer); timer = setTimeout(() => loadUsers(e.target.value), 300); });

  const loadJobs = () => safe('ad-jobs', async (box) => {
    const { data } = await admin.jobs();
    const rows = [
      ...data.syncJobs.map((j) => ({ when: j.started_at, kind: j.job_type, status: j.status, detail: `${j.records_synced ?? 0} ${t('common.rows')}${j.error_message ? ` · ${j.error_message}` : ''}` })),
      ...data.imports.map((j) => ({ when: j.created_at, kind: `import:${j.entity_type}`, status: j.status, detail: `${j.imported_rows}/${j.total_rows} · ${t('import.errors')} ${j.error_rows}${j.error_message ? ` · ${j.error_message}` : ''}` })),
    ].sort((a, b) => String(b.when).localeCompare(String(a.when))).slice(0, 30);
    render(box, rows.length ? html`<div class="table-container"><table class="text-xs"><thead><tr><th>${t('audit.time')}</th><th>${t('admin.job')}</th><th>${t('common.status')}</th><th>${t('audit.details')}</th></tr></thead>
      <tbody>${rows.map((r) => html`<tr><td>${new Date(r.when).toLocaleString()}</td><td class="font-mono">${r.kind}</td><td><span class="${r.status === 'failed' ? 'badge-red' : r.status === 'done' ? 'badge-green' : 'badge-gray'}">${r.status}</span></td><td>${r.detail}</td></tr>`)}</tbody></table></div>` : html`<p class="text-sm text-slate-500">—</p>`);
  });
  loadJobs();

  safe('ad-sec', async (box) => {
    const { data } = await admin.audit({ security: 'true', limit: 50 });
    render(box, html`<div class="table-container"><table class="text-xs"><thead><tr><th>${t('audit.time')}</th><th>${t('audit.actor')}</th><th>${t('audit.action')}</th><th>IP</th></tr></thead>
      <tbody>${data.map((a) => html`<tr><td>${new Date(a.created_at).toLocaleString()}</td><td>${a.actor_email || '—'}</td><td><span class="${/failed|locked|suspend/.test(a.action) ? 'badge-red' : 'badge-gray'}">${a.action}</span></td><td class="font-mono">${a.ip_address || ''}</td></tr>`)}</tbody></table></div>`);
  });
}
