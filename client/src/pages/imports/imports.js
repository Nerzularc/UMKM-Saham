import { imports, portfolios, integrations } from '../../services/api.js';
import { appState } from '../../state/store.js';
import { t } from '../../i18n/index.js';
import { html, render, spinner, errorBox, emptyState, pageHeader, num, date, toast, raw } from '../../components/ui.js';

export async function renderImports(el) {
  const org = appState.get('currentOrg');
  const role = org?.role_name;
  render(el, spinner());
  let entities; let pfList;
  try {
    [entities, pfList] = await Promise.all([imports.entities().then((r) => r.data), portfolios.list().then((r) => r.data)]);
  } catch (err) { return render(el, errorBox(err)); }
  const franchiseOk = org && (org.modules_enabled || []).includes('franchise') && ['org_owner', 'manager', 'staff'].includes(role);
  const available = entities.filter((e) => (e.module === 'stocks' ? pfList.length > 0 : franchiseOk));

  render(el, html`
    ${pageHeader(t('nav.imports'), t('import.subtitle'))}
    <ol class="flex flex-wrap gap-2 text-xs mb-4" aria-label="${t('import.steps')}">
      ${['import.step1', 'import.step2', 'import.step3', 'import.step4'].map((k, i) => html`<li class="badge-gray" data-step="${i + 1}">${i + 1}. ${t(k)}</li>`)}
    </ol>
    <section class="card mb-6" id="imp-wizard"></section>
    <section class="mb-6"><h3 class="mb-3">${t('import.history')}</h3><div id="imp-history">${spinner()}</div></section>
    <section><h3 class="mb-3">${t('import.integrations')}</h3><div id="imp-int">${spinner()}</div></section>`);

  const setStep = (n) => el.querySelectorAll('[data-step]').forEach((s) => { s.className = Number(s.dataset.step) === n ? 'badge-blue' : Number(s.dataset.step) < n ? 'badge-green' : 'badge-gray'; });
  const wiz = document.getElementById('imp-wizard');

  function step1() {
    setStep(1);
    if (!available.length) return render(wiz, emptyState(t('import.nothing'), t('import.nothingDesc')));
    render(wiz, html`<form id="imp-form" class="space-y-4">
      <div class="grid grid-cols-1 md:grid-cols-3 gap-3">
        <div><label class="form-label" for="imp-entity">${t('import.type')}</label>
          <select id="imp-entity" class="form-select">${available.map((e) => html`<option value="${e.key}">${t(`import.entity.${e.key}`)}</option>`)}</select></div>
        <div id="imp-ctx"></div>
        <div><label class="form-label" for="imp-file">${t('import.file')}</label>
          <input id="imp-file" type="file" accept=".csv,.xlsx" class="form-input py-1.5" required></div>
      </div>
      <div class="flex flex-wrap items-center gap-3">
        <button type="submit" class="btn-primary">${t('import.upload')}</button>
        <button type="button" id="imp-template" class="btn-secondary btn-sm">${t('import.template')}</button>
        <span class="text-xxs text-slate-500">${t('import.fileRules')}</span>
      </div>
      <div id="imp-fields" class="text-xs text-slate-400"></div>
      <div id="imp-err"></div></form>`);
    const entityEl = document.getElementById('imp-entity');
    const ctx = () => {
      const e = available.find((x) => x.key === entityEl.value);
      render(document.getElementById('imp-ctx'), e.module === 'stocks'
        ? html`<label class="form-label" for="imp-portfolio">${t('portfolio.title')}</label><select id="imp-portfolio" class="form-select">${pfList.map((p) => html`<option value="${p.id}">${p.name}</option>`)}</select>`
        : html`<label class="form-label">${t('org.organisation')}</label><p class="form-input bg-transparent">${org.org_name}</p>`);
      render(document.getElementById('imp-fields'), html`${t('import.columns')}: ${e.fields.map((f) => html`<code class="mr-1 ${f.required ? 'text-slate-200' : ''}">${f.key}${f.required ? '*' : ''}</code>`)}`);
    };
    entityEl.addEventListener('change', ctx); ctx();
    document.getElementById('imp-template').addEventListener('click', () => imports.template(entityEl.value).catch((err) => toast(err.message, 'error')));
    document.getElementById('imp-form').addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const file = document.getElementById('imp-file').files[0];
      const errEl = document.getElementById('imp-err');
      if (!file) return render(errEl, errorBox({ message: t('import.chooseFile') }));
      const entity = available.find((x) => x.key === entityEl.value);
      const context = entity.module === 'stocks' ? { portfolioId: document.getElementById('imp-portfolio').value } : { orgId: org.org_id };
      const btn = ev.target.querySelector('button[type=submit]');
      btn.disabled = true; btn.textContent = t('common.loading');
      try {
        const { data } = await imports.upload(entity.key, context, file);
        step2(data);
      } catch (err) { render(errEl, errorBox(err)); btn.disabled = false; btn.textContent = t('import.upload'); }
    });
  }

  function step2(up) {
    setStep(2);
    render(wiz, html`
      <div class="flex flex-wrap items-center justify-between gap-2 mb-3">
        <h3>${up.filename} · ${num(up.totalRows, 0)} ${t('common.rows')}</h3>
        ${up.previouslyImported ? html`<span class="badge-yellow">${t('import.previously', { date: date(up.previouslyImported.completedAt) })}</span>` : ''}
      </div>
      ${up.truncated ? html`<div class="alert-warning mb-3"><span>⚠</span><span>${t('import.truncated')}</span></div>` : ''}
      <p class="text-sm text-slate-400 mb-3">${t('import.mapHelp')}</p>
      <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3 mb-4">
        ${up.fields.map((f) => html`<div><label class="form-label" for="map-${f.key}">${f.key}${f.required ? ' *' : ''}</label>
          <select id="map-${f.key}" data-field="${f.key}" class="form-select py-1.5"><option value="">— ${t('import.skip')} —</option>
          ${up.headers.map((h) => html`<option value="${h}" ${up.suggestedMapping[f.key] === h ? raw('selected') : ''}>${h}</option>`)}</select></div>`)}
      </div>
      <h4 class="mb-2">${t('import.sample')}</h4>
      <div class="table-container mb-4"><table class="text-xs"><thead><tr>${up.headers.map((h) => html`<th>${h}</th>`)}</tr></thead>
        <tbody>${up.sampleRows.map((r) => html`<tr>${up.headers.map((h) => html`<td>${r[h]}</td>`)}</tr>`)}</tbody></table></div>
      <div id="map-err"></div>
      <div class="flex gap-2"><button id="map-validate" class="btn-primary">${t('import.validate')}</button><button id="map-cancel" class="btn-secondary">${t('common.cancel')}</button></div>`);
    document.getElementById('map-cancel').addEventListener('click', async () => { await imports.cancel(up.id).catch(() => {}); step1(); history(); });
    document.getElementById('map-validate').addEventListener('click', async (ev) => {
      const mapping = Object.fromEntries([...wiz.querySelectorAll('[data-field]')].map((s) => [s.dataset.field, s.value]).filter(([, v]) => v));
      ev.target.disabled = true;
      try {
        const { data } = await imports.validate(up.id, mapping);
        step3(up, data);
      } catch (err) { render(document.getElementById('map-err'), errorBox(err)); ev.target.disabled = false; }
    });
  }

  function step3(up, v) {
    setStep(3);
    const cols = v.preview[0] ? Object.keys(v.preview[0]) : [];
    render(wiz, html`
      <div class="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
        <div class="metric-card"><p class="metric-label">${t('import.total')}</p><p class="metric-value">${num(v.totalRows, 0)}</p></div>
        <div class="metric-card"><p class="metric-label">${t('import.valid')}</p><p class="metric-value tag-up">${num(v.validRows, 0)}</p></div>
        <div class="metric-card"><p class="metric-label">${t('import.duplicates')}</p><p class="metric-value text-yellow-400">${num(v.duplicateRows, 0)}</p></div>
        <div class="metric-card"><p class="metric-label">${t('import.errors')}</p><p class="metric-value ${v.errorRows ? 'tag-down' : ''}">${num(v.errorRows, 0)}</p></div>
      </div>
      ${v.errors.length ? html`<h4 class="mb-2">${t('import.problems')}</h4><div class="table-container mb-4 max-h-64 overflow-y-auto"><table class="text-xs">
        <thead><tr><th>${t('import.row')}</th><th>${t('import.column')}</th><th>${t('import.code')}</th><th>${t('import.message')}</th></tr></thead>
        <tbody>${v.errors.map((e) => html`<tr><td>${e.rowNumber}</td><td>${e.column || '—'}</td><td><span class="${e.code.startsWith('DUPLICATE') ? 'badge-yellow' : 'badge-red'}">${e.code}</span></td><td>${e.message}</td></tr>`)}</tbody></table></div>` : ''}
      ${v.preview.length ? html`<h4 class="mb-2">${t('import.willImport')}</h4><div class="table-container mb-4 max-h-64 overflow-y-auto"><table class="text-xs">
        <thead><tr>${cols.map((c) => html`<th>${c}</th>`)}</tr></thead><tbody>${v.preview.map((r) => html`<tr>${cols.map((c) => html`<td>${r[c]}</td>`)}</tr>`)}</tbody></table></div>` : ''}
      <div id="conf-err"></div>
      <div class="flex flex-wrap gap-2">
        <button id="conf-go" class="btn-primary" ${v.validRows ? '' : raw('disabled')}>${t('import.confirm', { n: v.validRows })}</button>
        <button id="conf-back" class="btn-secondary">${t('import.changeMapping')}</button>
        <button id="conf-cancel" class="btn-secondary">${t('common.cancel')}</button>
      </div>
      <p class="text-xxs text-slate-500 mt-2">${t('import.atomic')}</p>`);
    document.getElementById('conf-back').addEventListener('click', () => step2(up));
    document.getElementById('conf-cancel').addEventListener('click', async () => { await imports.cancel(up.id).catch(() => {}); step1(); history(); });
    document.getElementById('conf-go').addEventListener('click', async (ev) => {
      ev.target.disabled = true; ev.target.textContent = t('common.loading');
      try {
        const { data } = await imports.confirm(up.id);
        step4(up, data);
      } catch (err) { render(document.getElementById('conf-err'), errorBox(err)); }
    });
  }

  function step4(up, r) {
    setStep(4);
    render(wiz, html`<div class="alert-success mb-4"><span>✓</span><span>${t('import.done', { n: r.importedRows })}</span></div>
      <p class="text-sm text-slate-400 mb-4">${t('import.doneDetail', { e: r.errorRows, d: r.duplicateRows })}</p>
      <div class="flex gap-2">${r.errorRows || r.duplicateRows ? html`<button id="done-report" class="btn-secondary">${t('import.errorReport')}</button>` : ''}
        <button id="done-new" class="btn-primary">${t('import.another')}</button></div>`);
    document.getElementById('done-report')?.addEventListener('click', () => imports.errorReport(up.id));
    document.getElementById('done-new').addEventListener('click', step1);
    history();
  }

  async function history() {
    const target = document.getElementById('imp-history');
    try {
      const { data } = await imports.list({});
      if (!data.length) return render(target, emptyState(t('import.noHistory')));
      render(target, html`<div class="table-container"><table class="text-xs">
        <thead><tr><th>${t('common.date')}</th><th>${t('import.type')}</th><th>${t('import.file')}</th><th class="text-right">${t('import.total')}</th>
          <th class="text-right">${t('import.imported')}</th><th class="text-right">${t('import.duplicates')}</th><th class="text-right">${t('import.errors')}</th><th>${t('common.status')}</th><th></th></tr></thead>
        <tbody>${data.map((b) => html`<tr><td>${date(b.created_at)}</td><td>${t(`import.entity.${b.entity_type}`)}</td><td>${b.filename}</td>
          <td class="text-right">${b.total_rows}</td><td class="text-right">${b.imported_rows}</td><td class="text-right">${b.duplicate_rows}</td><td class="text-right">${b.error_rows}</td>
          <td><span class="${{ done: 'badge-green', failed: 'badge-red', cancelled: 'badge-gray' }[b.status] || 'badge-blue'}">${t(`import.status.${b.status}`)}</span>${b.error_message ? html`<div class="text-red-300">${b.error_message}</div>` : ''}</td>
          <td>${b.error_rows || b.duplicate_rows ? html`<button class="btn-secondary btn-sm" data-report="${b.id}">${t('import.errorReport')}</button>` : ''}</td></tr>`)}</tbody></table></div>`);
      target.querySelectorAll('[data-report]').forEach((b) => b.addEventListener('click', () => imports.errorReport(b.dataset.report)));
    } catch (err) { render(target, errorBox(err)); }
  }

  async function integrationStatus() {
    const target = document.getElementById('imp-int');
    try {
      const { data } = await integrations.status();
      const row = (name, status, desc, last) => html`<tr><td class="text-slate-100">${name}</td>
        <td><span class="${status === 'live' ? 'badge-green' : status === 'manual' ? 'badge-blue' : 'badge-yellow'}">${t(`int.${status}`)}</span></td>
        <td class="text-xs text-slate-400">${desc}</td><td class="text-xs">${last ? html`${t(`import.status.${last.status}`, {}, last.status)} · ${date(last.completed_at || last.started_at)}` : '—'}</td></tr>`;
      render(target, html`<div class="table-container"><table>
        <thead><tr><th>${t('int.integration')}</th><th>${t('common.status')}</th><th>${t('common.description')}</th><th>${t('int.lastSync')}</th></tr></thead>
        <tbody>
          ${row(t('int.marketData'), data.marketData.live ? 'live' : 'demo', data.marketData.provider === 'demo' ? t('int.desc.demo') : data.marketData.description, data.marketData.lastSync)}
          ${row(t('int.currency'), data.currency.configured ? 'live' : 'demo', data.currency.provider === 'demo' ? t('int.desc.demoFx') : data.currency.description, data.currency.lastSync)}
          ${row(t('int.broker'), 'manual', t('int.brokerDesc'), null)}
          ${row(t('int.pos'), 'manual', t('int.posDesc'), null)}
        </tbody></table></div>`);
    } catch (err) { render(target, errorBox(err)); }
  }

  step1();
  history();
  integrationStatus();
}
