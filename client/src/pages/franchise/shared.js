import { brands, regions, outlets } from '../../services/api.js';
import { appState } from '../../state/store.js';
import { t } from '../../i18n/index.js';
import { html, periodPicker, bindPeriodPicker, defaultPeriod, raw } from '../../components/ui.js';

const cache = new Map();

export async function loadStructure(orgId, { force = false } = {}) {
  if (!force && cache.has(orgId)) return cache.get(orgId);
  const [b, r, o] = await Promise.all([brands.list(orgId), regions.list({ orgId }), outlets.list({ orgId })]);
  const s = { brands: b.data, regions: r.data, outlets: o.data };
  cache.set(orgId, s);
  return s;
}
export function invalidateStructure(orgId) { cache.delete(orgId); }

export const currentOrg = () => appState.get('currentOrg');
export const role = () => currentOrg()?.role_name;
export const canSeeFinancials = () => ['org_owner', 'manager'].includes(role());
export const canExport = () => ['org_owner', 'manager'].includes(role());
export const isOwner = () => role() === 'org_owner';

/**
 * Filter bar: brand / region / outlet / status + period.
 * Returns { html, bind(onChange) } — onChange receives the full filter object.
 */
export function filterBar(id, structure, { period = defaultPeriod('mtd'), outlet = true, status = true, extra = '' } = {}) {
  const state = { brandId: '', regionId: '', outletId: '', status: '', ...period };
  const markup = html`<div class="card mb-6 flex flex-wrap gap-3 items-end" id="${id}">
    <div><label class="form-label" for="${id}-brand">${t('franchise.brand')}</label>
      <select id="${id}-brand" class="form-select py-1.5"><option value="">${t('common.all')}</option>
      ${structure.brands.map((b) => html`<option value="${b.id}">${b.name}</option>`)}</select></div>
    <div><label class="form-label" for="${id}-region">${t('franchise.region')}</label>
      <select id="${id}-region" class="form-select py-1.5"><option value="">${t('common.all')}</option>
      ${structure.regions.map((r) => html`<option value="${r.id}">${r.name}</option>`)}</select></div>
    ${outlet ? html`<div><label class="form-label" for="${id}-outlet">${t('franchise.outlet')}</label>
      <select id="${id}-outlet" class="form-select py-1.5"><option value="">${t('common.allOutlets')}</option>
      ${structure.outlets.map((o) => html`<option value="${o.id}">${o.code ? `${o.code} · ` : ''}${o.name}</option>`)}</select></div>` : ''}
    ${status ? html`<div><label class="form-label" for="${id}-status">${t('common.status')}</label>
      <select id="${id}-status" class="form-select py-1.5"><option value="">${t('common.all')}</option>
      ${['active', 'inactive', 'renovating', 'closed'].map((s) => html`<option value="${s}">${t(`outlet.status.${s}`)}</option>`)}</select></div>` : ''}
    ${periodPicker(`${id}-period`, period)}
    ${raw(extra)}
  </div>`;

  return {
    html: markup,
    state,
    bind(onChange) {
      const pick = (sfx, key) => document.getElementById(`${id}-${sfx}`)?.addEventListener('change', (e) => { state[key] = e.target.value; onChange({ ...state }); });
      pick('brand', 'brandId'); pick('region', 'regionId'); pick('outlet', 'outletId'); pick('status', 'status');
      bindPeriodPicker(`${id}-period`, (p) => { Object.assign(state, p); onChange({ ...state }); });
    },
  };
}

export function outletOptions(structure, selected = '') {
  return structure.outlets.map((o) => ({ value: o.id, label: `${o.code ? `${o.code} · ` : ''}${o.name}`, selected: o.id === selected }));
}
