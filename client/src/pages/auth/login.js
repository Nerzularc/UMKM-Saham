import { auth } from '../../services/api.js';
import { t, getLocale, setLocale } from '../../i18n/index.js';
import { html, render, errorBox } from '../../components/ui.js';
import { navigate } from '../../app/router.js';
import { startSession } from '../../state/session.js';

const DEMO_ACCOUNTS = [
  ['owner@demo.local', 'role.org_owner'],
  ['manager@demo.local', 'role.manager'],
  ['staff@demo.local', 'role.staff'],
  ['personal@demo.local', 'role.personal'],
  ['owner2@demo.local', 'login.secondOrg'],
  ['superadmin@demo.local', 'role.superadmin'],
];

export function renderLoginPage(app) {
  let mode = 'login';
  let needTotp = false;

  const draw = () => render(app, html`
    <main class="min-h-screen flex items-center justify-center bg-surface-950 p-4">
      <div class="w-full max-w-md">
        <div class="text-center mb-6">
          <div class="w-14 h-14 bg-brand-600 rounded-2xl flex items-center justify-center text-white text-xl font-bold mx-auto mb-3" aria-hidden="true">US</div>
          <h1 class="text-2xl font-bold text-slate-100">UMKM Saham</h1>
          <p class="text-slate-400 mt-1 text-sm">${t('app.tagline')}</p>
          <button id="locale-toggle" class="btn-secondary btn-sm mt-3">${getLocale() === 'id' ? 'English' : 'Bahasa Indonesia'}</button>
        </div>

        <div class="flex bg-surface-800 rounded-xl p-1 mb-4" role="tablist">
          <button role="tab" aria-selected="${mode === 'login'}" id="tab-login" class="flex-1 py-2 rounded-lg text-sm font-medium ${mode === 'login' ? 'bg-brand-600 text-white' : 'text-slate-400'}">${t('auth.login')}</button>
          <button role="tab" aria-selected="${mode === 'register'}" id="tab-register" class="flex-1 py-2 rounded-lg text-sm font-medium ${mode === 'register' ? 'bg-brand-600 text-white' : 'text-slate-400'}">${t('auth.register')}</button>
        </div>

        ${mode === 'login' ? html`
        <form id="login-form" class="card space-y-4" novalidate>
          <div><label class="form-label" for="login-email">${t('auth.email')}</label>
            <input type="email" id="login-email" name="email" class="form-input" autocomplete="username" required></div>
          <div><label class="form-label" for="login-password">${t('auth.password')}</label>
            <input type="password" id="login-password" name="password" class="form-input" autocomplete="current-password" required></div>
          ${needTotp ? html`<div><label class="form-label" for="login-totp">${t('auth.totp')}</label>
            <input id="login-totp" name="totp" class="form-input font-mono tracking-widest" inputmode="numeric" autocomplete="one-time-code" maxlength="6" pattern="[0-9]{6}" required></div>` : ''}
          <div id="form-error"></div>
          <button type="submit" class="btn-primary w-full">${t('auth.login')}</button>
        </form>` : html`
        <form id="register-form" class="card space-y-4" novalidate>
          <div><label class="form-label" for="reg-name">${t('auth.fullName')}</label>
            <input id="reg-name" name="fullName" class="form-input" autocomplete="name" required minlength="2"></div>
          <div><label class="form-label" for="reg-email">${t('auth.email')}</label>
            <input type="email" id="reg-email" name="email" class="form-input" autocomplete="email" required></div>
          <div><label class="form-label" for="reg-password">${t('auth.password')}</label>
            <input type="password" id="reg-password" name="password" class="form-input" autocomplete="new-password" required minlength="8">
            <p class="text-xxs text-slate-500 mt-1">${t('auth.passwordRule')}</p></div>
          <div id="form-error"></div>
          <button type="submit" class="btn-primary w-full">${t('auth.register')}</button>
        </form>`}

        <section class="mt-5" aria-labelledby="demo-title">
          <div class="demo-banner mb-2"><span aria-hidden="true">⚠</span><span id="demo-title">${t('login.demoAccounts')}</span></div>
          <div class="grid grid-cols-2 sm:grid-cols-3 gap-2">
            ${DEMO_ACCOUNTS.map(([email, label]) => html`<button type="button" class="demo-login btn-secondary btn-sm text-xs" data-email="${email}">${t(label)}</button>`)}
          </div>
          <p class="text-xxs text-slate-500 mt-2 text-center">${t('login.demoPasswordHint')}</p>
        </section>
      </div>
    </main>`);

  const bind = () => {
    document.getElementById('locale-toggle').addEventListener('click', () => { setLocale(getLocale() === 'id' ? 'en' : 'id'); draw(); bind(); });
    document.getElementById('tab-login').addEventListener('click', () => { mode = 'login'; draw(); bind(); });
    document.getElementById('tab-register').addEventListener('click', () => { mode = 'register'; draw(); bind(); });
    document.querySelectorAll('.demo-login').forEach((b) => b.addEventListener('click', () => {
      if (mode !== 'login') { mode = 'login'; draw(); bind(); }
      document.getElementById('login-email').value = b.dataset.email;
      document.getElementById('login-password').value = 'Demo@1234';
      document.getElementById('login-form').requestSubmit();
    }));

    const form = document.getElementById(mode === 'login' ? 'login-form' : 'register-form');
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const err = document.getElementById('form-error');
      const btn = form.querySelector('button[type=submit]');
      const data = Object.fromEntries(new FormData(form).entries());
      render(err, '');
      if (!form.checkValidity()) { render(err, errorBox({ message: t('common.checkForm') })); return; }
      btn.disabled = true;
      try {
        if (mode === 'register') {
          await auth.register({ ...data, locale: getLocale() });
        }
        const res = await auth.login({ email: data.email, password: data.password, ...(data.totp ? { totp: data.totp } : {}) });
        startSession(res.data.user);
        navigate('#/dashboard');
      } catch (ex) {
        if (ex.code === 'TOTP_REQUIRED' && !needTotp) {
          needTotp = true;
          const email = data.email; const pw = data.password;
          draw(); bind();
          document.getElementById('login-email').value = email;
          document.getElementById('login-password').value = pw;
          document.getElementById('login-totp').focus();
          return;
        }
        render(err, errorBox(ex));
        btn.disabled = false;
      }
    });
  };

  draw();
  bind();
}
