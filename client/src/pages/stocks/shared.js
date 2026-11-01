import { portfolios } from '../../services/api.js';
import { html } from '../../components/ui.js';
import { t } from '../../i18n/index.js';

/** Load portfolios and return [list, selectedId] honouring ?portfolio= and last choice. */
export async function loadPortfolios(params = {}) {
  const { data } = await portfolios.list();
  let saved = null;
  try { saved = sessionStorage.getItem('portfolio'); } catch { /* ignore */ }
  const ids = data.map((p) => p.id);
  const selected = [params.portfolio, saved].find((x) => x && ids.includes(x)) || ids[0] || null;
  return [data, selected];
}

export function rememberPortfolio(id) {
  try { sessionStorage.setItem('portfolio', id); } catch { /* ignore */ }
}

export function portfolioSelect(list, selected, id = 'portfolio-select') {
  return html`<label class="sr-only" for="${id}">${t('portfolio.select')}</label>
    <select id="${id}" class="form-select py-1.5 w-auto">
    ${list.map((p) => html`<option value="${p.id}" ${p.id === selected ? 'selected' : ''}>${p.name}${p.portfolio_type === 'simulation' ? ` (${t('portfolio.simulation')})` : ''}</option>`)}
  </select>`;
}
