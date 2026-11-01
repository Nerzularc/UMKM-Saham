import { targets } from '../../services/api.js';
import { t } from '../../i18n/index.js';
import { html, render, spinner, errorBox, emptyState, pageHeader, money, num, openModal, field, toast, confirmAction } from '../../components/ui.js';
import { loadStructure, currentOrg, role, outletOptions } from './shared.js';

export async function renderTargets(el) {
  const org = currentOrg();
  const canManage = ['org_owner', 'manager'].includes(role());
  const year = new Date().getFullYear();
  render(el, spinner());
  let structure;
  try { structure = await loadStructure(org.org_id); } catch (err) { return render(el, errorBox(err)); }

  render(el, html`
    ${pageHeader(t('nav.targets'), t('target.subtitle'), canManage ? html`<button id="t-new" class="btn-primary">+ ${t('target.new')}</button>` : '')}
    <div class="card mb-4 flex flex-wrap gap-3 items-end">
      <div><label class="form-label" for="t-year">${t('target.year')}</label>
        <select id="t-year" class="form-select py-1.5">${[year + 1, year, year - 1, year - 2].map((y) => html`<option value="${y}" ${y === year ? 'selected' : ''}>${y}</option>`)}</select></div>
      <div><label class="form-label" for="t-outlet">${t('franchise.outlet')}</label>
        <select id="t-outlet" class="form-select py-1.5"><option value="">${t('common.allOutlets')}</option>${outletOptions(structure).map((o) => html`<option value="${o.value}">${o.label}</option>`)}</select></div>
    </div>
    <p class="text-xxs text-slate-500 mb-3">${t('target.note')}</p>
    <div id="t-body">${spinner()}</div>`);

  const load = async () => {
    const body = document.getElementById('t-body');
    try {
      const { data } = await targets.list({ orgId: org.org_id, year: document.getElementById('t-year').value, outletId: document.getElementById('t-outlet').value });
      if (!data.length) return render(body, html`<div class="card">${emptyState(t('target.empty'), '', '🎯')}</div>`);
      render(body, html`<div class="table-container"><table>
        <thead><tr><th>${t('common.period')}</th><th>${t('target.scope')}</th><th>${t('target.metric')}</th><th class="text-right">${t('franchise.target')}</th>
          <th class="text-right">${t('target.actual')}</th><th class="text-right">${t('franchise.achievement')}</th><th></th></tr></thead>
        <tbody>${data.map((x) => html`<tr>
          <td class="whitespace-nowrap">${t(`target.period.${x.period_type}`)} ${x.period_value ? `${x.period_value}/` : ''}${x.period_year}<div class="text-xxs text-slate-500">${x.period_from} → ${x.period_to}</div></td>
          <td>${x.outlet_name || x.brand_name || x.region_name || t('target.wholeOrg')}</td>
          <td class="text-xs">${t(`target.type.${x.target_type}`)}</td>
          <td class="text-right font-mono">${x.target_type === 'transactions' ? num(x.target_amount, 0) : money(x.target_amount)}</td>
          <td class="text-right font-mono">${x.target_type === 'transactions' ? num(x.actual, 0) : money(x.actual)}</td>
          <td class="text-right font-mono w-40">${x.achievement_pct === null ? '—' : `${num(x.achievement_pct, 1)}%`}
            ${x.achievement_pct !== null ? html`<div class="h-1.5 bg-slate-800 rounded mt-1" aria-hidden="true"><div class="h-1.5 rounded ${x.achievement_pct >= 100 ? 'bg-green-500' : x.achievement_pct >= 80 ? 'bg-yellow-500' : 'bg-red-500'}" style="width:${Math.min(100, x.achievement_pct)}%"></div></div>` : ''}</td>
          <td>${canManage ? html`<button class="btn-secondary btn-sm" data-del="${x.id}" aria-label="${t('common.delete')}">✕</button>` : ''}</td></tr>`)}</tbody></table></div>`);
      body.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', async () => {
        if (!(await confirmAction({ title: t('target.delete'), message: t('target.deleteMsg'), confirmLabel: t('common.delete') }))) return;
        try { await targets.delete(b.dataset.del); load(); } catch (err) { toast(err.message, 'error'); }
      }));
    } catch (err) { render(body, errorBox(err)); }
  };

  document.getElementById('t-year').addEventListener('change', load);
  document.getElementById('t-outlet').addEventListener('change', load);
  document.getElementById('t-new')?.addEventListener('click', () => {
    const form = openModal({
      title: t('target.new'),
      body: html`<div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
        ${field({ name: 'outletId', label: t('franchise.outlet'), options: [...(role() === 'org_owner' ? [{ value: '', label: t('target.wholeOrg') }] : []), ...outletOptions(structure)] })}
        ${field({ name: 'targetType', label: t('target.metric'), value: 'sales', options: [{ value: 'sales', label: t('target.type.sales') }, { value: 'transactions', label: t('target.type.transactions') }] })}
        ${field({ name: 'periodType', label: t('target.periodType'), value: 'monthly', options: ['daily', 'weekly', 'monthly', 'yearly'].map((p) => ({ value: p, label: t(`target.period.${p}`) })) })}
        ${field({ name: 'periodYear', label: t('target.year'), type: 'number', value: year, required: true, attrs: 'min="2000" max="2100"' })}
        ${field({ name: 'periodValue', label: t('target.periodValue'), type: 'number', value: new Date().getMonth() + 1, attrs: 'min="1" max="366"', help: t('target.periodValueHelp') })}
        ${field({ name: 'targetAmount', label: t('franchise.target'), type: 'number', required: true, attrs: 'min="1" step="any"' })}
      </div>`,
      onSubmit: async (d) => {
        await targets.create({ orgId: org.org_id, ...d, outletId: d.outletId || null, periodYear: Number(d.periodYear), periodValue: d.periodType === 'yearly' ? null : Number(d.periodValue), targetAmount: Number(d.targetAmount) });
        toast(t('common.saved'));
        load();
      },
    });
    const pt = form.querySelector('[name=periodType]');
    pt.addEventListener('change', () => { form.querySelector('[name=periodValue]').closest('div').classList.toggle('hidden', pt.value === 'yearly'); });
  });
  await load();
}
