import './styles/main.css';
import { appState } from './state/store.js';
import { auth } from './services/api.js';
import { setLocale, getLocale, t } from './i18n/index.js';
import { navigate } from './app/router.js';
import { startSession, endSession } from './state/session.js';

async function init() {
  setLocale(getLocale());
  try {
    const { data } = await auth.session();
    if (data.user) {
      startSession(data.user);
      let stored = null;
      try { stored = localStorage.getItem('locale'); } catch { /* ignore */ }
      if (data.user.locale && !stored) setLocale(data.user.locale);
    }
  } catch {
    // not signed in
  }
  document.getElementById('loading-splash')?.remove();
  const hash = window.location.hash;
  navigate(hash && hash !== '#/login' ? hash : (appState.get('user') ? '#/dashboard' : '#/login'));
}

window.addEventListener('auth:logout', () => {
  endSession();
  navigate('#/login');
});

init().catch((err) => {
  console.error('App init failed:', err);
  const splash = document.getElementById('loading-splash');
  if (splash) splash.textContent = t('common.error');
});
