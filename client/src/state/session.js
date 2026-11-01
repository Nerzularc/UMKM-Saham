import { appState } from './store.js';

function restoreOrg(memberships) {
  let saved = null;
  try { saved = localStorage.getItem('currentOrg'); } catch { /* storage unavailable */ }
  return memberships.find((m) => m.org_id === saved) || memberships[0] || null;
}

export function startSession(user) {
  appState.set('user', user);
  appState.set('memberships', user.memberships || []);
  appState.set('currentOrg', restoreOrg(user.memberships || []));
}

export function endSession() {
  appState.set('user', null);
  appState.set('memberships', []);
  appState.set('currentOrg', null);
}
