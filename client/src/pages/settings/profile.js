import { users, auth } from '../../services/api.js';
import { appState } from '../../state/store.js';
import { t, setLocale } from '../../i18n/index.js';
import { html, render, spinner, errorBox, pageHeader, date, field, toast, confirmAction } from '../../components/ui.js';

export async function renderProfile(el) {
  render(el, spinner());
  let me;
  try { me = (await users.me()).data; } catch (err) { return render(el, errorBox(err)); }

  render(el, html`${pageHeader(t('nav.profile'), me.email)}
    <div class="grid grid-cols-1 xl:grid-cols-2 gap-6">
      <form id="p-form" class="card space-y-4"><h3>${t('profile.details')}</h3>
        ${field({ name: 'fullName', label: t('auth.fullName'), value: me.full_name, required: true })}
        <div class="grid grid-cols-2 gap-3">
          ${field({ name: 'locale', label: t('profile.language'), value: me.locale, options: [{ value: 'id', label: 'Bahasa Indonesia' }, { value: 'en', label: 'English' }] })}
          ${field({ name: 'timezone', label: t('org.timezone'), value: me.timezone })}
        </div>
        <div id="p-err"></div><button class="btn-primary" type="submit">${t('common.save')}</button>
      </form>

      <form id="pw-form" class="card space-y-4"><h3>${t('profile.password')}</h3>
        ${field({ name: 'currentPassword', label: t('profile.currentPassword'), type: 'password', required: true, attrs: 'autocomplete="current-password"' })}
        ${field({ name: 'newPassword', label: t('profile.newPassword'), type: 'password', required: true, attrs: 'autocomplete="new-password" minlength="8"', help: t('auth.passwordRule') })}
        <div id="pw-err"></div><button class="btn-primary" type="submit">${t('profile.changePassword')}</button>
        <p class="text-xxs text-slate-500">${t('profile.passwordNote')}</p>
      </form>

      <section class="card space-y-3" id="tfa"><h3>${t('profile.twoFactor')}</h3><div id="tfa-body"></div></section>

      <section class="card"><div class="card-header"><h3>${t('profile.sessions')}</h3><button id="logout-all" class="btn-secondary btn-sm">${t('profile.logoutAll')}</button></div>
        <ul class="text-xs divide-y divide-slate-800">${me.sessions.map((s) => html`<li class="py-2 flex justify-between gap-2">
          <span class="truncate">${s.user_agent || '—'}<div class="text-slate-500">${s.ip_address || ''} · ${t('profile.lastUsed')} ${date(s.last_used_at)}</div></span>
          ${s.current ? html`<span class="badge-green">${t('profile.thisDevice')}</span>` : ''}</li>`)}</ul></section>
    </div>`);

  document.getElementById('p-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const d = Object.fromEntries(new FormData(e.target).entries());
    try {
      await users.update(d);
      setLocale(d.locale);
      appState.set('user', { ...appState.get('user'), fullName: d.fullName });
      toast(t('common.saved'));
      const { navigate } = await import('../../app/router.js');
      const { renderShell } = await import('../../app/shell.js');
      renderShell(true); navigate('#/profile');
    } catch (err) { render(document.getElementById('p-err'), errorBox(err)); }
  });

  document.getElementById('pw-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const d = Object.fromEntries(new FormData(e.target).entries());
    try {
      await auth.changePassword(d);
      toast(t('profile.passwordChanged'), 'info');
      window.dispatchEvent(new CustomEvent('auth:logout'));
    } catch (err) { render(document.getElementById('pw-err'), errorBox(err)); }
  });

  document.getElementById('logout-all').addEventListener('click', async () => {
    if (!(await confirmAction({ title: t('profile.logoutAll'), message: t('profile.logoutAllMsg') }))) return;
    await auth.logoutAll().catch(() => {});
    window.dispatchEvent(new CustomEvent('auth:logout'));
  });

  const tfa = document.getElementById('tfa-body');
  const drawTfa = (enabled) => {
    if (enabled) {
      render(tfa, html`<p class="text-sm"><span class="badge-green">${t('profile.tfaOn')}</span></p>
        <form id="tfa-off" class="grid grid-cols-1 sm:grid-cols-3 gap-2 items-end">
          ${field({ name: 'password', label: t('auth.password'), type: 'password', required: true })}
          ${field({ name: 'code', label: t('auth.totp'), required: true, attrs: 'inputmode="numeric" maxlength="6"' })}
          <button class="btn-secondary" type="submit">${t('profile.tfaDisable')}</button></form><div id="tfa-err"></div>`);
      document.getElementById('tfa-off').addEventListener('submit', async (e) => {
        e.preventDefault();
        try { await auth.disable2fa(Object.fromEntries(new FormData(e.target).entries())); toast(t('common.saved')); drawTfa(false); } catch (err) { render(document.getElementById('tfa-err'), errorBox(err)); }
      });
    } else {
      render(tfa, html`<p class="text-sm text-slate-400">${t('profile.tfaIntro')}</p>${me.is_superadmin ? html`<p class="text-xs text-yellow-400">${t('profile.tfaRecommended')}</p>` : ''}
        <button id="tfa-start" class="btn-primary btn-sm">${t('profile.tfaSetup')}</button><div id="tfa-step"></div>`);
      document.getElementById('tfa-start').addEventListener('click', async () => {
        try {
          const { data } = await auth.setup2fa();
          render(document.getElementById('tfa-step'), html`<div class="mt-3 space-y-2 text-sm">
            <p>${t('profile.tfaStep1')}</p>
            <p class="font-mono bg-surface-800 rounded p-2 break-all select-all">${data.secret}</p>
            <p class="text-xxs text-slate-500 break-all">${data.otpauthUri}</p>
            <form id="tfa-on" class="flex gap-2 items-end">${field({ name: 'code', label: t('profile.tfaStep2'), required: true, attrs: 'inputmode="numeric" maxlength="6" autocomplete="one-time-code"' })}
              <button class="btn-primary" type="submit">${t('profile.tfaEnable')}</button></form><div id="tfa-err"></div></div>`);
          document.getElementById('tfa-on').addEventListener('submit', async (e) => {
            e.preventDefault();
            try { await auth.enable2fa(e.target.code.value); toast(t('profile.tfaEnabled')); drawTfa(true); } catch (err) { render(document.getElementById('tfa-err'), errorBox(err)); }
          });
        } catch (err) { toast(err.message, 'error'); }
      });
    }
  };
  drawTfa(me.two_factor_enabled);
}
