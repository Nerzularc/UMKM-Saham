/**
 * Application state — simple reactive store using EventTarget.
 */

class Store extends EventTarget {
  #state;

  constructor(initial) {
    super();
    this.#state = { ...initial };
  }

  get(key) {
    return this.#state[key];
  }

  set(key, value) {
    const old = this.#state[key];
    this.#state[key] = value;
    this.dispatchEvent(new CustomEvent('change', { detail: { key, value, old } }));
    this.dispatchEvent(new CustomEvent(`change:${key}`, { detail: { value, old } }));
  }

  getAll() {
    return { ...this.#state };
  }

  subscribe(key, callback) {
    const handler = (e) => callback(e.detail.value, e.detail.old);
    this.addEventListener(`change:${key}`, handler);
    return () => this.removeEventListener(`change:${key}`, handler);
  }
}

export const appState = new Store({
  user: null,          // authenticated user object
  memberships: [],     // org memberships
  currentOrg: null,   // currently selected organisation
  currentPage: null,  // active page key
  locale: localStorage.getItem('locale') || 'id',
  demoMode: false,
  sidebarOpen: false,
  loading: false,
  notifications: [],
});
