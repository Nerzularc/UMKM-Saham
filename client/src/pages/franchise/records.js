/**
 * Shared list/CRUD page for sales and expenses (same filter, totals, pagination,
 * export, correction-with-reason and approval handling).
 */
import { t } from '../../i18n/index.js';
import {
  html, render, spinner, errorBox, emptyState, pageHeader, money, date, openModal, field, confirmAction, toast,
  exportButtons, bindExportButtons, pager, bindPager, defaultPeriod, todayIso, raw,
} from '../../components/ui.js';
import { loadStructure, filterBar, currentOrg, canExport, outletOptions } from './shared.js';

export async function recordsPage(el, cfg) {
  const org = currentOrg();
  render(el, spinner());
  let structure;
  try { structure = await loadStructure(org.org_id); } catch (err) { return render(el, errorBox(err)); }
  const extra = cfg.extraFilters ? await cfg.extraFilters(org) : '';
  const bar = filterBar(cfg.id, structure, { period: defaultPeriod('mtd'), status: false, extra: String(extra) });
  render(el, html`
    ${pageHeader(cfg.title, cfg.subtitle, html`${canExport() ? exportButtons(`${cfg.id}-export`) : ''}<button id="${cfg.id}-new" class="btn-primary" ${structure.outlets.length ? '' : raw('disabled')}>+ ${cfg.newLabel}</button>`)}
    ${bar.html}
    <div id="${cfg.id}-totals" class="mb-4"></div>
    <div id="${cfg.id}-table">${spinner()}</div>`);

  let filters = { ...bar.state };
  let page = 1;
  bar.bind((f) => { filters = f; page = 1; load(); });
  cfg.bindExtra?.((patch) => { Object.assign(filters, patch); page = 1; load(); });
  if (canExport()) bindExportButtons(`${cfg.id}-export`, cfg.dataset, () => ({ orgId: org.org_id, ...filters }));
  document.getElementById(`${cfg.id}-new`).addEventListener('click', () => form(null));

  async function load() {
    const target = document.getElementById(`${cfg.id}-table`);
    render(target, spinner());
    try {
      const params = { ...filters, page, limit: 50 };
      if (!params.outletId) params.orgId = org.org_id;
      const res = await cfg.api.list(params);
      render(document.getElementById(`${cfg.id}-totals`), cfg.totals(res.meta));
      if (!res.data.length) return render(target, html`<div class="card">${emptyState(cfg.emptyLabel)}</div>`);
      render(target, html`<div class="table-container"><table>
        <thead><tr>${cfg.columns.map((c) => html`<th class="${c.right ? 'text-right' : ''}">${c.label}</th>`)}<th><span class="sr-only">${t('common.actions')}</span></th></tr></thead>
        <tbody>${res.data.map((r) => html`<tr>${cfg.columns.map((c) => html`<td class="${c.right ? 'text-right font-mono' : ''}">${c.cell(r)}</td>`)}
          <td class="whitespace-nowrap"><button class="btn-secondary btn-sm" data-edit="${r.id}" aria-label="${t('common.edit')}">✎</button>
          <button class="btn-secondary btn-sm text-red-300" data-del="${r.id}" aria-label="${t('common.delete')}">✕</button></td></tr>`)}</tbody>
      </table></div>${pager(res.meta)}`);
      bindPager(target, (p) => { page = p; load(); });
      target.querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', () => form(res.data.find((r) => r.id === b.dataset.edit))));
      target.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', async () => {
        const reason = await confirmAction({ title: cfg.deleteTitle, message: t('records.deleteMsg'), confirmLabel: t('common.delete'), requireReason: true });
        if (!reason) return;
        try {
          const r = await cfg.api.delete(b.dataset.del, reason);
          toast(r?.data?.approval ? t('approval.submitted') : t('common.deleted'), r?.data?.approval ? 'info' : 'success');
          load();
        } catch (err) { toast(err.message, 'error'); }
      }));
    } catch (err) { render(target, errorBox(err)); }
  }

  async function form(rec) {
    const fields = await cfg.formFields(rec, structure, org);
    openModal({
      title: rec ? cfg.editLabel : cfg.newLabel,
      body: html`${rec ? html`<div class="alert-info"><span>ⓘ</span><span>${t('records.correctionNotice')}</span></div>` : ''}
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">${fields}</div>
        ${rec ? field({ name: 'reason', label: t('common.reason'), required: true, attrs: 'minlength="3"' }) : ''}`,
      onSubmit: async (d) => {
        const body = cfg.toBody(d);
        const r = rec ? await cfg.api.update(rec.id, body) : await cfg.api.create(body);
        toast(r?.data?.approval ? t('approval.submitted') : t('common.saved'), r?.data?.approval ? 'info' : 'success');
        load();
      },
    });
  }

  await load();
}

export const outletField = (structure, rec) => field({
  name: 'outletId', label: t('franchise.outlet'), required: true, value: rec?.outlet_id || '',
  options: outletOptions(structure), attrs: rec ? 'disabled' : '',
});
export const dateField = (name, rec, value) => field({ name, label: t('common.date'), type: 'date', required: true, value: value || todayIso(), attrs: `max="${todayIso()}" ${rec ? 'disabled' : ''}` });
export { money, date };
