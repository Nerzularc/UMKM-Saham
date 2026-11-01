import { outlets, organisations } from '../../services/api.js';
import { t } from '../../i18n/index.js';
import { html, render, spinner, errorBox, emptyState, pageHeader, money, pct, date, openModal, field, toast, defaultPeriod } from '../../components/ui.js';
import { loadStructure, invalidateStructure, currentOrg, isOwner } from './shared.js';

const STATUSES = ['active', 'inactive', 'renovating', 'closed'];

export async function renderOutlets(el) {
  const org = currentOrg();
  render(el, html`${pageHeader(t('nav.outlets'), t('outlet.subtitle'), isOwner() ? html`<button id="o-new" class="btn-primary">+ ${t('outlet.new')}</button>` : '')}
    <div class="card mb-4 flex flex-wrap gap-3 items-end">
      <div><label class="form-label" for="o-q">${t('common.search')}</label><input id="o-q" class="form-input py-1.5" placeholder="${t('outlet.searchPlaceholder')}"></div>
      <div><label class="form-label" for="o-status">${t('common.status')}</label><select id="o-status" class="form-select py-1.5"><option value="">${t('common.all')}</option>
        ${STATUSES.map((s) => html`<option value="${s}">${t(`outlet.status.${s}`)}</option>`)}</select></div>
    </div>
    <div id="o-body">${spinner()}</div>`);

  let structure;
  async function load() {
    const body = document.getElementById('o-body');
    try {
      structure = await loadStructure(org.org_id, { force: true });
      const q = document.getElementById('o-q').value;
      const status = document.getElementById('o-status').value;
      const { data } = await outlets.list({ orgId: org.org_id, q, status });
      if (!data.length) return render(body, html`<div class="card">${emptyState(t('franchise.noOutlets'), isOwner() ? t('outlet.emptyOwner') : t('outlet.emptyScoped'), '🏪')}</div>`);
      render(body, html`<div class="table-container"><table>
        <thead><tr><th>${t('common.code')}</th><th>${t('common.name')}</th><th>${t('franchise.brand')}</th><th>${t('franchise.region')}</th>
          <th>${t('outlet.city')}</th><th>${t('outlet.openingDate')}</th><th>${t('outlet.managers')}</th><th>${t('common.status')}</th><th></th></tr></thead>
        <tbody>${data.map((o) => html`<tr>
          <td class="font-mono text-xs">${o.code || '—'}</td><td class="text-slate-100">${o.name}</td><td>${o.brand_name || '—'}</td><td>${o.region_name || '—'}</td>
          <td>${o.city || '—'}</td><td class="text-xs">${date(o.opening_date)}</td>
          <td class="text-xs">${(o.managers || []).map((m) => m.fullName).join(', ') || '—'}</td>
          <td><span class="${o.status === 'active' ? 'badge-green' : 'badge-yellow'}">${t(`outlet.status.${o.status}`)}</span></td>
          <td class="whitespace-nowrap"><button class="btn-secondary btn-sm" data-view="${o.id}">${t('common.details')}</button>
            ${isOwner() ? html`<button class="btn-secondary btn-sm" data-edit="${o.id}">${t('common.edit')}</button>` : ''}</td></tr>`)}</tbody></table></div>`);
      body.querySelectorAll('[data-view]').forEach((b) => b.addEventListener('click', () => details(data.find((o) => o.id === b.dataset.view))));
      body.querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', () => edit(data.find((o) => o.id === b.dataset.edit))));
    } catch (err) { render(body, errorBox(err)); }
  }

  function edit(o) {
    openModal({
      title: o ? t('outlet.edit') : t('outlet.new'),
      wide: true,
      body: html`<div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
        ${field({ name: 'name', label: t('common.name'), value: o?.name || '', required: true })}
        ${field({ name: 'code', label: t('common.code'), value: o?.code || '', help: t('outlet.codeHelp') })}
        ${field({ name: 'brandId', label: t('franchise.brand'), value: o?.brand_id || '', required: true, options: structure.brands.map((b) => ({ value: b.id, label: b.name })) })}
        ${field({ name: 'regionId', label: t('franchise.region'), value: o?.region_id || '', options: [{ value: '', label: '—' }, ...structure.regions.map((r) => ({ value: r.id, label: r.name }))] })}
        ${field({ name: 'city', label: t('outlet.city'), value: o?.city || '' })}
        ${field({ name: 'province', label: t('outlet.province'), value: o?.province || '' })}
        ${field({ name: 'address', label: t('outlet.address'), value: o?.address || '' })}
        ${field({ name: 'phone', label: t('outlet.phone'), value: o?.phone || '' })}
        ${field({ name: 'openingDate', label: t('outlet.openingDate'), type: 'date', value: o?.opening_date || '' })}
        ${field({ name: 'status', label: t('common.status'), value: o?.status || 'active', options: STATUSES.map((s) => ({ value: s, label: t(`outlet.status.${s}`) })) })}
      </div>`,
      onSubmit: async (d) => {
        const body = Object.fromEntries(Object.entries(d).filter(([, v]) => v !== ''));
        if (o) await outlets.update(o.id, body); else await outlets.create({ ...body, orgId: org.org_id });
        invalidateStructure(org.org_id);
        toast(t('common.saved'));
        load();
      },
    });
  }

  async function details(o) {
    const form = openModal({ title: `${o.name}`, wide: true, body: html`<div id="o-detail">${spinner()}</div>` });
    void form;
    const target = document.getElementById('o-detail');
    try {
      const period = defaultPeriod('mtd');
      const [{ data: sum }, assign, members] = await Promise.all([
        outlets.summary(o.id, period),
        outlets.assignments(o.id).catch(() => ({ data: null })),
        isOwner() ? organisations.members(org.org_id) : Promise.resolve({ data: [] }),
      ]);
      const p = sum.pnl;
      render(target, html`
        <p class="text-xs text-slate-500">${t('franchise.mtd')} · ${sum.period.from} → ${sum.period.to}</p>
        <dl class="grid grid-cols-2 sm:grid-cols-3 gap-3 text-sm">
          <div><dt class="metric-label">${t('franchise.netSales')}</dt><dd class="font-mono">${money(p.netSales)}</dd></div>
          <div><dt class="metric-label">${t('franchise.transactions')}</dt><dd class="font-mono">${p.transactionCount}</dd></div>
          <div><dt class="metric-label">${t('franchise.atv')}</dt><dd class="font-mono">${money(p.averageTransactionValue)}</dd></div>
          ${p.grossProfit !== undefined ? html`
          <div><dt class="metric-label">${t('franchise.grossProfit')}</dt><dd class="font-mono">${money(p.grossProfit)}</dd></div>
          <div><dt class="metric-label">${t('franchise.netProfit')}</dt><dd class="font-mono">${money(p.netProfit)}</dd></div>
          <div><dt class="metric-label">${t('franchise.netMargin')}</dt><dd class="font-mono">${pct(p.netMarginPct)}</dd></div>` : ''}
        </dl>
        <div class="text-sm text-slate-400">${o.address || ''} ${o.city || ''}</div>
        ${assign.data ? html`<h4 class="mt-2">${t('outlet.assignments')}</h4>
          <ul class="text-sm divide-y divide-slate-800">${assign.data.map((a) => html`<li class="py-1.5 flex justify-between"><span>${a.full_name} <span class="text-xxs text-slate-500">${a.email}</span></span>
            <span class="${a.is_active ? 'badge-blue' : 'badge-gray'}">${t(`role.${a.role}`)}</span></li>`)}</ul>` : ''}
        ${isOwner() ? html`<form id="assign-form" class="flex flex-wrap gap-2 items-end mt-2">
          <div><label class="form-label" for="as-user">${t('outlet.assignUser')}</label><select id="as-user" class="form-select py-1.5">
            ${members.data.filter((m) => m.role_name !== 'org_owner' && m.is_active).map((m) => html`<option value="${m.id}">${m.full_name} (${t(`role.${m.role_name}`)})</option>`)}</select></div>
          <div><label class="form-label" for="as-role">${t('outlet.assignRole')}</label><select id="as-role" class="form-select py-1.5">
            <option value="manager">${t('role.manager')}</option><option value="staff">${t('role.staff')}</option></select></div>
          <button class="btn-secondary btn-sm" type="submit">${t('outlet.assign')}</button></form>` : ''}`);
      document.getElementById('assign-form')?.addEventListener('submit', async (e) => {
        e.preventDefault();
        try {
          await outlets.assign(o.id, { userId: document.getElementById('as-user').value, role: document.getElementById('as-role').value });
          toast(t('common.saved'));
          details(o);
        } catch (err) { toast(err.message, 'error'); }
      });
    } catch (err) { render(target, errorBox(err)); }
  }

  document.getElementById('o-new')?.addEventListener('click', () => edit(null));
  document.getElementById('o-q').addEventListener('input', () => { clearTimeout(window.__oq); window.__oq = setTimeout(load, 300); });
  document.getElementById('o-status').addEventListener('change', load);
  await load();
}
