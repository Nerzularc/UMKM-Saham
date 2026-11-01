import { inventory, products } from '../../services/api.js';
import { t } from '../../i18n/index.js';
import {
  html, render, spinner, errorBox, emptyState, pageHeader, money, num, date, openModal, field, toast, kpi,
  exportButtons, bindExportButtons, todayIso,
} from '../../components/ui.js';
import { loadStructure, currentOrg, canExport, isOwner, role, outletOptions } from './shared.js';

const MOVES = ['receive', 'issue', 'sale', 'waste', 'adjustment'];

export async function renderInventory(el) {
  const org = currentOrg();
  render(el, spinner());
  let structure; let productList;
  try {
    [structure, productList] = await Promise.all([loadStructure(org.org_id), products.list({ orgId: org.org_id }).then((r) => r.data)]);
  } catch (err) { return render(el, errorBox(err)); }
  const canTransfer = ['org_owner', 'manager'].includes(role());
  let outletId = '';
  let lowOnly = false;

  render(el, html`
    ${pageHeader(t('nav.inventory'), t('inv.subtitle'), html`${canExport() ? exportButtons('inv-export') : ''}
      ${isOwner() ? html`<button id="inv-products" class="btn-secondary">${t('inv.products')}</button>` : ''}
      ${canTransfer ? html`<button id="inv-transfer" class="btn-secondary">${t('inv.transfer')}</button>` : ''}
      <button id="inv-move" class="btn-primary">+ ${t('inv.movement')}</button>`)}
    <div class="card mb-4 flex flex-wrap gap-3 items-end">
      <div><label class="form-label" for="inv-outlet">${t('franchise.outlet')}</label>
        <select id="inv-outlet" class="form-select py-1.5"><option value="">${t('common.allOutlets')}</option>
        ${outletOptions(structure).map((o) => html`<option value="${o.value}">${o.label}</option>`)}</select></div>
      <label class="flex items-center gap-2 text-sm text-slate-300"><input type="checkbox" id="inv-low" class="rounded"> ${t('inv.lowOnly')}</label>
    </div>
    <div id="inv-kpis" class="mb-4"></div>
    <div id="inv-table">${spinner()}</div>
    <h3 class="mt-8 mb-3">${t('inv.history')}</h3>
    <div id="inv-moves">${spinner()}</div>`);

  const params = () => (outletId ? { outletId } : { orgId: org.org_id });
  if (canExport()) bindExportButtons('inv-export', 'inventory', params);
  document.getElementById('inv-outlet').addEventListener('change', (e) => { outletId = e.target.value; load(); });
  document.getElementById('inv-low').addEventListener('change', (e) => { lowOnly = e.target.checked; load(); });
  document.getElementById('inv-move').addEventListener('click', () => movementForm());
  document.getElementById('inv-transfer')?.addEventListener('click', () => transferForm());
  document.getElementById('inv-products')?.addEventListener('click', () => productsModal());

  async function load() {
    const target = document.getElementById('inv-table');
    try {
      const res = await inventory.balances({ ...params(), ...(lowOnly ? { lowOnly: 'true' } : {}) });
      render(document.getElementById('inv-kpis'), html`<div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        ${kpi(t('inv.items'), num(res.meta.items, 0))}
        ${kpi(t('inv.lowStock'), num(res.meta.lowStock, 0), { subTone: res.meta.lowStock ? 'tag-down' : '' })}
        ${kpi(t('inv.value'), money(res.meta.stockValue), { sub: res.meta.unvaluedItems ? t('inv.unvalued', { n: res.meta.unvaluedItems }) : t('inv.valuationBasis'), hint: t('hint.inventoryValue') })}
      </div>`);
      if (!res.data.length) {
        render(target, html`<div class="card">${emptyState(lowOnly ? t('franchise.stockOk') : t('inv.empty'), '', lowOnly ? '✅' : '📦')}</div>`);
        loadMoves();
        return;
      }
      render(target, html`<div class="table-container"><table>
        <thead><tr><th>${t('franchise.outlet')}</th><th>SKU</th><th>${t('inv.product')}</th><th class="text-right">${t('stocks.quantity')}</th>
          <th class="text-right">${t('inv.reorder')}</th><th class="text-right">${t('inv.unitCost')}</th><th class="text-right">${t('inv.value')}</th><th>${t('common.status')}</th></tr></thead>
        <tbody>${res.data.map((r) => html`<tr>
          <td class="text-xs">${r.outlet_name}</td><td class="font-mono text-xs">${r.sku || '—'}</td><td>${r.product_name}</td>
          <td class="text-right font-mono">${num(r.quantity, 2)} ${r.unit}</td><td class="text-right font-mono text-slate-400">${r.reorder_level}</td>
          <td class="text-right font-mono">${r.unit_cost === null ? '—' : money(r.unit_cost)}</td><td class="text-right font-mono">${r.stock_value === null ? '—' : money(r.stock_value)}</td>
          <td>${r.is_low ? html`<span class="badge-red">${t('inv.low')}</span>` : html`<span class="badge-green">OK</span>`}</td></tr>`)}</tbody></table></div>`);
    } catch (err) { render(target, errorBox(err)); }
    loadMoves();
  }

  async function loadMoves() {
    const target = document.getElementById('inv-moves');
    try {
      const { data } = await inventory.movements({ ...params(), limit: 50 });
      if (!data.length) return render(target, emptyState(t('inv.noMoves')));
      render(target, html`<div class="table-container"><table>
        <thead><tr><th>${t('common.date')}</th><th>${t('franchise.outlet')}</th><th>${t('inv.product')}</th><th>${t('inv.type')}</th>
          <th class="text-right">${t('stocks.quantity')}</th><th>${t('tx.notes')}</th><th>${t('inv.by')}</th></tr></thead>
        <tbody>${data.map((m) => html`<tr><td class="text-xs whitespace-nowrap">${date(m.movement_date)}</td><td class="text-xs">${m.outlet_name}</td>
          <td>${m.product_name}</td><td><span class="badge-gray">${t(`inv.move.${m.movement_type}`)}</span></td>
          <td class="text-right font-mono ${Number(m.quantity) < 0 ? 'tag-down' : 'tag-up'}">${Number(m.quantity) > 0 ? '+' : ''}${num(m.quantity, 2)}</td>
          <td class="text-xs text-slate-400">${m.notes || ''}</td><td class="text-xs text-slate-500">${m.moved_by_name || ''}</td></tr>`)}</tbody></table></div>`);
    } catch (err) { render(target, errorBox(err)); }
  }

  const productOpts = () => productList.map((p) => ({ value: p.id, label: `${p.sku ? `${p.sku} · ` : ''}${p.name}` }));

  function movementForm() {
    const form = openModal({
      title: t('inv.movement'),
      body: html`<div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
        ${field({ name: 'outletId', label: t('franchise.outlet'), required: true, value: outletId, options: outletOptions(structure) })}
        ${field({ name: 'productId', label: t('inv.product'), required: true, options: productOpts() })}
        ${field({ name: 'movementType', label: t('inv.type'), value: 'receive', options: MOVES.map((m) => ({ value: m, label: t(`inv.move.${m}`) })) })}
        ${field({ name: 'quantity', label: t('stocks.quantity'), type: 'number', required: true, attrs: 'step="any"', help: t('inv.qtyHelp') })}
        ${field({ name: 'unitCost', label: t('inv.unitCost'), type: 'number', attrs: 'min="0" step="any"' })}
        ${field({ name: 'movementDate', label: t('common.date'), type: 'date', value: todayIso(), attrs: `max="${todayIso()}"` })}
      </div>${field({ name: 'notes', label: t('tx.notes'), help: t('inv.adjustmentNote') })}`,
      onSubmit: async (d) => {
        await inventory.addMovement({ ...d, quantity: Number(d.quantity), unitCost: d.unitCost === '' ? null : Number(d.unitCost), notes: d.notes || null });
        toast(t('common.saved'));
        load();
      },
    });
    void form;
  }

  function transferForm() {
    openModal({
      title: t('inv.transfer'),
      body: html`<div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
        ${field({ name: 'fromOutletId', label: t('inv.from'), required: true, options: outletOptions(structure) })}
        ${field({ name: 'toOutletId', label: t('inv.to'), required: true, options: outletOptions(structure) })}
        ${field({ name: 'productId', label: t('inv.product'), required: true, options: productOpts() })}
        ${field({ name: 'quantity', label: t('stocks.quantity'), type: 'number', required: true, attrs: 'min="0" step="any"' })}
      </div>${field({ name: 'notes', label: t('tx.notes') })}`,
      onSubmit: async (d) => {
        await inventory.transfer({ ...d, quantity: Number(d.quantity) });
        toast(t('common.saved'));
        load();
      },
    });
  }

  function productsModal() {
    openModal({
      title: t('inv.products'),
      wide: true,
      submitLabel: t('inv.addProduct'),
      body: html`<div class="table-container mb-4"><table><thead><tr><th>SKU</th><th>${t('common.name')}</th><th>${t('inv.unit')}</th><th class="text-right">${t('inv.unitCost')}</th><th class="text-right">${t('inv.reorder')}</th></tr></thead>
        <tbody>${productList.map((p) => html`<tr><td class="font-mono text-xs">${p.sku || ''}</td><td>${p.name}</td><td>${p.unit}</td><td class="text-right font-mono">${p.unit_cost === null ? '—' : money(p.unit_cost)}</td><td class="text-right">${p.reorder_level}</td></tr>`)}</tbody></table></div>
        <h4>${t('inv.addProduct')}</h4>
        <div class="grid grid-cols-2 sm:grid-cols-3 gap-3">
          ${field({ name: 'sku', label: 'SKU' })}${field({ name: 'name', label: t('common.name'), required: true })}${field({ name: 'unit', label: t('inv.unit'), value: 'pcs' })}
          ${field({ name: 'unitCost', label: t('inv.unitCost'), type: 'number', attrs: 'min="0" step="any"' })}
          ${field({ name: 'reorderLevel', label: t('inv.reorder'), type: 'number', value: 0, attrs: 'min="0" step="1"' })}
          ${field({ name: 'category', label: t('expense.category') })}
        </div>`,
      onSubmit: async (d) => {
        await products.create({ orgId: org.org_id, ...d, unitCost: d.unitCost === '' ? null : Number(d.unitCost), reorderLevel: Number(d.reorderLevel || 0) });
        productList = (await products.list({ orgId: org.org_id })).data;
        toast(t('common.saved'));
      },
    });
  }

  await load();
}
