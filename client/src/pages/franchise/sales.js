import { sales } from '../../services/api.js';
import { t } from '../../i18n/index.js';
import { html, field, kpi, num } from '../../components/ui.js';
import { recordsPage, outletField, dateField, money, date } from './records.js';

export function renderSales(el) {
  return recordsPage(el, {
    id: 'sales',
    title: t('nav.sales'),
    subtitle: t('sales.subtitle'),
    newLabel: t('sales.new'),
    editLabel: t('sales.edit'),
    deleteTitle: t('sales.deleteTitle'),
    emptyLabel: t('franchise.noSales'),
    dataset: 'sales',
    api: sales,
    totals: (m) => html`<div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
      ${kpi(t('franchise.grossSales'), money(m.totals.grossSales))}
      ${kpi(t('sales.discounts'), money(m.totals.discounts))}
      ${kpi(t('sales.returns'), money(m.totals.returns))}
      ${kpi(t('franchise.netSales'), money(m.totals.netSales), { hint: t('hint.netSales') })}
      ${kpi(t('franchise.transactions'), num(m.totals.transactionCount, 0), { sub: m.totals.transactionCount ? `${t('franchise.atv')} ${money(m.totals.netSales / m.totals.transactionCount)}` : '' })}
    </div>`,
    columns: [
      { label: t('common.date'), cell: (r) => date(r.sale_date) },
      { label: t('franchise.outlet'), cell: (r) => html`${r.outlet_name}<div class="text-xxs text-slate-500">${r.outlet_code || ''} ${r.source !== 'manual' ? `· ${r.source}` : ''}</div>` },
      { label: t('franchise.grossSales'), right: true, cell: (r) => money(r.gross_sales) },
      { label: t('sales.discounts'), right: true, cell: (r) => money(r.discounts) },
      { label: t('sales.returns'), right: true, cell: (r) => money(r.returns) },
      { label: t('franchise.netSales'), right: true, cell: (r) => money(r.net_sales) },
      { label: t('franchise.transactions'), right: true, cell: (r) => num(r.transaction_count, 0) },
    ],
    formFields: (rec, structure) => html`
      ${outletField(structure, rec)}
      ${dateField('saleDate', rec, rec?.sale_date)}
      ${field({ name: 'grossSales', label: t('franchise.grossSales'), type: 'number', required: true, value: rec?.gross_sales ?? '', attrs: 'min="0" step="any"' })}
      ${field({ name: 'discounts', label: t('sales.discounts'), type: 'number', value: rec?.discounts ?? 0, attrs: 'min="0" step="any"' })}
      ${field({ name: 'returns', label: t('sales.returns'), type: 'number', value: rec?.returns ?? 0, attrs: 'min="0" step="any"' })}
      ${field({ name: 'transactionCount', label: t('franchise.transactions'), type: 'number', value: rec?.transaction_count ?? 0, attrs: 'min="0" step="1"' })}
      ${field({ name: 'notes', label: t('tx.notes'), value: rec?.notes || '' })}`,
    toBody: (d) => ({
      ...(d.outletId && { outletId: d.outletId }),
      ...(d.saleDate && { saleDate: d.saleDate }),
      grossSales: Number(d.grossSales), discounts: Number(d.discounts || 0), returns: Number(d.returns || 0),
      transactionCount: Number(d.transactionCount || 0), notes: d.notes || null, ...(d.reason && { reason: d.reason }),
    }),
  });
}
