import { organisations, brands, regions, expenses, approvals, auth } from '../../services/api.js';
import { startSession } from '../../state/session.js';
import { appState } from '../../state/store.js';
import { t } from '../../i18n/index.js';
import { html, render, spinner, errorBox, emptyState, pageHeader, date, money, openModal, field, toast, confirmAction, raw } from '../../components/ui.js';
import { invalidateStructure } from '../franchise/shared.js';

export async function renderOrganisation(el, params = {}) {
  const org = appState.get('currentOrg');
  const owner = org.role_name === 'org_owner';
  const canReview = ['org_owner', 'manager'].includes(org.role_name);
  const tabs = [['overview', t('org.overview')], ...(canReview ? [['members', t('org.members')]] : []), ...(owner ? [['structure', t('org.structure')]] : []), ['approvals', t('org.approvals')]];
  let tab = tabs.find(([k]) => k === params.tab)?.[0] || 'overview';

  render(el, html`${pageHeader(org.org_name, t(`role.${org.role_name}`), owner ? '' : '')}
    <div class="flex flex-wrap gap-2 mb-4" role="tablist">${tabs.map(([k, l]) => html`<button role="tab" data-tab="${k}" class="btn-sm ${k === tab ? 'btn-primary' : 'btn-secondary'}">${l}</button>`)}</div>
    <div id="org-body">${spinner()}</div>`);
  el.querySelectorAll('[data-tab]').forEach((b) => b.addEventListener('click', () => { tab = b.dataset.tab; el.querySelectorAll('[data-tab]').forEach((x) => { x.className = `btn-sm ${x.dataset.tab === tab ? 'btn-primary' : 'btn-secondary'}`; }); show(); }));
  const body = () => document.getElementById('org-body');

  async function show() {
    render(body(), spinner());
    try {
      if (tab === 'overview') await overview();
      if (tab === 'members') await members();
      if (tab === 'structure') await structure();
      if (tab === 'approvals') await approvalList();
    } catch (err) { render(body(), errorBox(err)); }
  }

  async function overview() {
    const { data: o } = await organisations.get(org.org_id);
    const a = o.settings?.approvals || {};
    const actions = ['sales.update', 'sales.delete', 'expenses.update', 'expenses.delete'];
    render(body(), html`<form id="org-form" class="card space-y-4 max-w-2xl">
      ${field({ name: 'name', label: t('common.name'), value: o.name, attrs: owner ? '' : 'disabled' })}
      <div class="grid grid-cols-2 gap-3">
        ${field({ name: 'defaultTimezone', label: t('org.timezone'), value: o.default_timezone, attrs: owner ? '' : 'disabled', help: t('org.timezoneHelp') })}
        <div><span class="form-label">${t('common.currency')}</span><p class="form-input bg-transparent">${o.default_currency}</p></div>
      </div>
      <fieldset><legend class="form-label">${t('org.modules')}</legend>
        ${['stocks', 'franchise'].map((m) => html`<label class="mr-4 text-sm"><input type="checkbox" name="mod_${m}" class="rounded" ${(o.modules_enabled || []).includes(m) ? raw('checked') : ''} ${owner ? '' : raw('disabled')}> ${t(`nav.${m}`)}</label>`)}
      </fieldset>
      <fieldset class="border border-slate-800 rounded-lg p-3"><legend class="form-label px-1">${t('org.approvalWorkflow')}</legend>
        <label class="text-sm block mb-2"><input type="checkbox" name="appr_enabled" class="rounded" ${a.enabled ? raw('checked') : ''} ${owner ? '' : raw('disabled')}> ${t('org.approvalEnabled')}</label>
        <label class="text-sm block mb-2"><input type="checkbox" name="appr_sod" class="rounded" ${a.separationOfDuties !== false ? raw('checked') : ''} ${owner ? '' : raw('disabled')}> ${t('org.sod')}</label>
        <div class="grid grid-cols-2 gap-1">${actions.map((x) => html`<label class="text-xs"><input type="checkbox" name="act_${x}" class="rounded" ${(a.actions || []).includes(x) ? raw('checked') : ''} ${owner ? '' : raw('disabled')}> ${t(`approval.action.${x}`)}</label>`)}</div>
      </fieldset>
      ${owner ? html`<div id="org-err"></div><button class="btn-primary" type="submit">${t('common.save')}</button>` : html`<p class="text-xs text-slate-500">${t('org.ownerOnly')}</p>`}
    </form>`);
    document.getElementById('org-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = e.target;
      try {
        await organisations.update(org.org_id, {
          name: f.name.value, defaultTimezone: f.defaultTimezone.value,
          modulesEnabled: ['stocks', 'franchise'].filter((m) => f[`mod_${m}`].checked),
          approvals: { enabled: f.appr_enabled.checked, separationOfDuties: f.appr_sod.checked, actions: actions.filter((x) => f[`act_${x}`].checked) },
        });
        // Refresh memberships so module changes apply immediately.
        const { data } = await auth.session();
        if (data.user) startSession(data.user);
        const { renderShell } = await import('../../app/shell.js');
        renderShell(true);
        toast(t('common.saved'));
        renderOrganisation(document.getElementById('main-content'), { tab: 'overview' });
      } catch (err) { render(document.getElementById('org-err'), errorBox(err)); }
    });
  }

  async function members() {
    const { data } = await organisations.members(org.org_id);
    render(body(), html`
      ${owner ? html`<form id="mem-add" class="card mb-4 flex flex-wrap gap-3 items-end">
        <div class="flex-1 min-w-[220px]"><label class="form-label" for="mem-email">${t('org.addMemberEmail')}</label><input id="mem-email" type="email" class="form-input" required></div>
        <div><label class="form-label" for="mem-role">${t('org.role')}</label><select id="mem-role" class="form-select"><option value="staff">${t('role.staff')}</option><option value="manager">${t('role.manager')}</option></select></div>
        <button class="btn-primary" type="submit">${t('common.add')}</button>
        <p class="w-full text-xxs text-slate-500">${t('org.addMemberHelp')}</p></form>` : ''}
      <div class="table-container"><table>
        <thead><tr><th>${t('common.name')}</th><th>${t('org.role')}</th><th>${t('nav.outlets')}</th><th>${t('common.status')}</th><th>${t('org.joined')}</th><th></th></tr></thead>
        <tbody>${data.map((m) => html`<tr class="${m.is_active ? '' : 'opacity-50'}">
          <td>${m.full_name}<div class="text-xxs text-slate-500">${m.email}</div></td>
          <td>${owner && m.role_name !== 'org_owner' ? html`<select class="form-select py-1 text-xs w-auto" data-role="${m.id}"><option value="staff" ${m.role_name === 'staff' ? raw('selected') : ''}>${t('role.staff')}</option><option value="manager" ${m.role_name === 'manager' ? raw('selected') : ''}>${t('role.manager')}</option></select>` : html`<span class="badge-blue">${t(`role.${m.role_name}`)}</span>`}</td>
          <td class="text-xs">${m.role_name === 'org_owner' ? t('org.allOutlets') : (m.outlets || []).map((o) => o.outletName).join(', ') || html`<span class="text-yellow-400">${t('org.noOutlets')}</span>`}</td>
          <td>${m.is_active ? html`<span class="badge-green">${t('common.active')}</span>` : html`<span class="badge-gray">${t('common.inactive')}</span>`}</td>
          <td class="text-xs">${date(m.joined_at)}</td>
          <td>${owner && m.role_name !== 'org_owner' ? html`<button class="btn-secondary btn-sm" data-toggle="${m.id}" data-active="${m.is_active}">${m.is_active ? t('org.deactivate') : t('org.reactivate')}</button>` : ''}</td></tr>`)}</tbody></table></div>
      <p class="text-xxs text-slate-500 mt-2">${t('org.assignHint')}</p>`);
    document.getElementById('mem-add')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      try { await organisations.addMember(org.org_id, { email: document.getElementById('mem-email').value, role: document.getElementById('mem-role').value }); toast(t('common.saved')); members(); } catch (err) { toast(err.message, 'error'); }
    });
    body().querySelectorAll('[data-role]').forEach((s) => s.addEventListener('change', async () => {
      try { await organisations.updateMember(org.org_id, s.dataset.role, { role: s.value }); toast(t('common.saved')); } catch (err) { toast(err.message, 'error'); members(); }
    }));
    body().querySelectorAll('[data-toggle]').forEach((b) => b.addEventListener('click', async () => {
      const activate = b.dataset.active !== 'true';
      if (!activate && !(await confirmAction({ title: t('org.deactivate'), message: t('org.deactivateMsg'), confirmLabel: t('org.deactivate') }))) return;
      try { await organisations.updateMember(org.org_id, b.dataset.toggle, { isActive: activate }); members(); } catch (err) { toast(err.message, 'error'); }
    }));
  }

  async function structure() {
    const [b, r, c] = await Promise.all([brands.list(org.org_id), regions.list({ orgId: org.org_id }), expenses.categories(org.org_id)]);
    render(body(), html`<div class="grid grid-cols-1 lg:grid-cols-3 gap-6">
      <section class="card"><div class="card-header"><h3>${t('franchise.brands')}</h3><button class="btn-secondary btn-sm" id="add-brand">+</button></div>
        <ul class="text-sm divide-y divide-slate-800">${b.data.map((x) => html`<li class="py-2 flex justify-between"><span>${x.name} <span class="text-xxs text-slate-500">${x.code || ''}</span></span><span class="text-xs text-slate-500">${x.outlet_count} ${t('nav.outlets')}</span></li>`)}</ul></section>
      <section class="card"><div class="card-header"><h3>${t('franchise.regions')}</h3><button class="btn-secondary btn-sm" id="add-region">+</button></div>
        <ul class="text-sm divide-y divide-slate-800">${r.data.map((x) => html`<li class="py-2 flex justify-between"><span>${x.name}</span><span class="text-xs text-slate-500">${x.outlet_count} ${t('nav.outlets')}</span></li>`)}</ul></section>
      <section class="card"><div class="card-header"><h3>${t('org.chartOfAccounts')}</h3><button class="btn-secondary btn-sm" id="add-cat">+</button></div>
        <ul class="text-sm divide-y divide-slate-800">${c.data.map((x) => html`<li class="py-2 flex justify-between"><span>${x.name} <span class="text-xxs text-slate-500">${x.code || ''}</span></span><span class="badge-gray">${t(`expense.type.${x.category_type}`)}</span></li>`)}</ul></section>
    </div>`);
    const simple = (title, fields, fn) => openModal({ title, body: fields, onSubmit: async (d) => { await fn(d); invalidateStructure(org.org_id); toast(t('common.saved')); structure(); } });
    document.getElementById('add-brand').addEventListener('click', () => simple(t('franchise.brand'), html`${field({ name: 'name', label: t('common.name'), required: true })}${field({ name: 'code', label: t('common.code') })}`, (d) => brands.create({ orgId: org.org_id, ...d })));
    document.getElementById('add-region').addEventListener('click', () => simple(t('franchise.region'), html`${field({ name: 'name', label: t('common.name'), required: true })}${field({ name: 'code', label: t('common.code') })}`, (d) => regions.create({ orgId: org.org_id, ...d })));
    document.getElementById('add-cat').addEventListener('click', () => simple(t('expense.category'), html`${field({ name: 'name', label: t('common.name'), required: true })}${field({ name: 'code', label: t('common.code') })}
      ${field({ name: 'categoryType', label: t('expense.categoryType'), options: ['operating', 'cogs', 'non_operating', 'tax'].map((x) => ({ value: x, label: t(`expense.type.${x}`) })) })}`, (d) => expenses.createCategory({ orgId: org.org_id, ...d })));
  }

  async function approvalList() {
    const { data } = await approvals.list({ orgId: org.org_id });
    if (!data.length) return render(body(), html`<div class="card">${emptyState(t('approval.none'), t('approval.noneDesc'), '✅')}</div>`);
    const fmt = (v) => (v && typeof v === 'object' ? Object.entries(v).filter(([, x]) => x !== null && x !== undefined).map(([k, x]) => `${k}: ${x}`).join(' · ') : '');
    render(body(), html`<div class="space-y-3">${data.map((a) => html`<article class="card">
      <div class="flex flex-wrap justify-between gap-2 mb-2">
        <div><span class="${{ pending: 'badge-yellow', approved: 'badge-green', rejected: 'badge-red' }[a.status]}">${t(`approval.status.${a.status}`)}</span>
          <span class="ml-2 text-slate-100">${t(`approval.resource.${a.resource_type}`)} · ${t(`approval.verb.${a.action}`)}</span></div>
        <span class="text-xs text-slate-500">${a.requested_by_name} · ${date(a.created_at)}</span></div>
      <p class="text-sm text-slate-300 mb-1">“${a.reason}”</p>
      <p class="text-xxs text-slate-500 font-mono break-all">${t('approval.before')}: ${a.old_values ? `${a.old_values.sale_date || a.old_values.expense_date || ''} ${money(a.old_values.gross_sales ?? a.old_values.amount)}` : '—'}</p>
      ${a.new_values ? html`<p class="text-xxs text-slate-400 font-mono break-all">${t('approval.after')}: ${fmt(a.new_values)}</p>` : ''}
      ${a.status === 'pending' && canReview ? html`<div class="flex gap-2 mt-3"><button class="btn-primary btn-sm" data-approve="${a.id}">${t('approval.approve')}</button><button class="btn-secondary btn-sm" data-reject="${a.id}">${t('approval.reject')}</button></div>` : ''}
      ${a.reviewed_by_name ? html`<p class="text-xxs text-slate-500 mt-2">${t('approval.reviewedBy')} ${a.reviewed_by_name} · ${date(a.reviewed_at)} ${a.review_notes ? `· ${a.review_notes}` : ''}</p>` : ''}
    </article>`)}</div>`);
    body().querySelectorAll('[data-approve]').forEach((b) => b.addEventListener('click', async () => {
      if (!(await confirmAction({ title: t('approval.approve'), message: t('approval.approveMsg'), confirmLabel: t('approval.approve') }))) return;
      try { await approvals.approve(b.dataset.approve); toast(t('common.saved')); approvalList(); } catch (err) { toast(err.message, 'error'); }
    }));
    body().querySelectorAll('[data-reject]').forEach((b) => b.addEventListener('click', async () => {
      const notes = await confirmAction({ title: t('approval.reject'), message: t('approval.rejectMsg'), confirmLabel: t('approval.reject'), requireReason: true });
      if (!notes) return;
      try { await approvals.reject(b.dataset.reject, notes); approvalList(); } catch (err) { toast(err.message, 'error'); }
    }));
  }

  show();
}
