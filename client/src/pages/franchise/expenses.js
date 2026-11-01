import { expenses } from '../../services/api.js';
import { t } from '../../i18n/index.js';
import { html, field, kpi, raw } from '../../components/ui.js';
import { recordsPage, outletField, dateField, money, date } from './records.js';

let categories = [];
const TYPE_LABEL = { cogs: 'expense.type.cogs', operating: 'expense.type.operating', non_operating: 'expense.type.non_operating', tax: 'expense.type.tax' };

export function renderExpenses(el) {
  return recordsPage(el, {
    id: 'exp',
    title: t('nav.expenses'),
    subtitle: t('expense.subtitle'),
    newLabel: t('expense.new'),
    editLabel: t('expense.edit'),
    deleteTitle: t('expense.deleteTitle'),
    emptyLabel: t('expense.empty'),
    dataset: 'expenses',
    api: expenses,
    async extraFilters(org) {
      categories = (await expenses.categories(org.org_id)).data;
      return html`<div><label class="form-label" for="exp-cat">${t('expense.category')}</label>
        <select id="exp-cat" class="form-select py-1.5"><option value="">${t('common.all')}</option>
        ${Object.keys(TYPE_LABEL).map((ty) => html`<optgroup label="${t(TYPE_LABEL[ty])}">${categories.filter((c) => c.category_type === ty).map((c) => html`<option value="${c.id}">${c.name}</option>`)}</optgroup>`)}
        </select></div>`;
    },
    bindExtra(onChange) {
      document.getElementById('exp-cat')?.addEventListener('change', (e) => onChange({ categoryId: e.target.value }));
    },
    totals: (m) => html`<div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
      ${kpi(t('common.total'), money(m.totalAmount))}
      ${(m.byCategory || []).slice(0, 4).map((c) => kpi(c.name, money(c.amount), { sub: t(TYPE_LABEL[c.category_type]) }))}
    </div>`,
    columns: [
      { label: t('common.date'), cell: (r) => date(r.expense_date) },
      { label: t('franchise.outlet'), cell: (r) => r.outlet_name },
      { label: t('expense.category'), cell: (r) => html`${r.category_name}<div class="text-xxs text-slate-500">${t(TYPE_LABEL[r.category_type])}</div>` },
      { label: t('common.description'), cell: (r) => html`${r.description || '—'}${r.reference ? html`<div class="text-xxs text-slate-500">${r.reference}</div>` : ''}` },
      { label: t('common.amount'), right: true, cell: (r) => money(r.amount) },
    ],
    formFields: (rec, structure) => html`
      ${outletField(structure, rec)}
      ${field({ name: 'expenseDate', label: t('common.date'), type: 'date', required: true, value: rec?.expense_date || new Date().toISOString().slice(0, 10) })}
      <div><label class="form-label" for="f-cat">${t('expense.category')} *</label><select id="f-cat" name="expenseCategoryId" class="form-select" required>
        ${Object.keys(TYPE_LABEL).map((ty) => html`<optgroup label="${t(TYPE_LABEL[ty])}">${categories.filter((c) => c.category_type === ty).map((c) => html`<option value="${c.id}" ${c.id === rec?.expense_category_id ? raw('selected') : ''}>${c.name}</option>`)}</optgroup>`)}
      </select></div>
      ${field({ name: 'amount', label: t('common.amount'), type: 'number', required: true, value: rec?.amount ?? '', attrs: 'min="0" step="any"' })}
      ${field({ name: 'description', label: t('common.description'), value: rec?.description || '' })}
      ${field({ name: 'reference', label: t('tx.reference'), value: rec?.reference || '' })}`,
    toBody: (d) => ({
      ...(d.outletId && { outletId: d.outletId }),
      expenseDate: d.expenseDate, expenseCategoryId: d.expenseCategoryId, amount: Number(d.amount),
      description: d.description || null, reference: d.reference || null, ...(d.reason && { reason: d.reason }),
    }),
  });
}
void dateField;
