/**
 * API service — every call to the backend goes through here.
 *
 * Authentication uses the HTTP-only `token` cookie set by the server (never
 * readable by JavaScript). For state-changing requests the readable
 * `csrf_token` cookie is echoed in the X-CSRF-Token header.
 */

const BASE = '/api/v1';
const SAFE = new Set(['GET', 'HEAD']);

function readCookie(name) {
  const match = document.cookie.split('; ').find((c) => c.startsWith(`${name}=`));
  return match ? decodeURIComponent(match.slice(name.length + 1)) : null;
}

export class ApiError extends Error {
  constructor(message, status, errors = null, code = null) {
    super(message);
    this.status = status;
    this.errors = errors;
    this.code = code;
  }
}

function qs(params = {}) {
  const clean = Object.fromEntries(Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== ''));
  const s = new URLSearchParams(clean).toString();
  return s ? `?${s}` : '';
}

async function request(method, path, body = null, { raw = false, form = null, silent401 = false } = {}) {
  const headers = {};
  if (!SAFE.has(method)) {
    const csrf = readCookie('csrf_token');
    if (csrf) headers['X-CSRF-Token'] = csrf;
  }
  const config = { method, headers, credentials: 'same-origin' };
  if (form) {
    config.body = form;
  } else if (body !== null && !SAFE.has(method)) {
    headers['Content-Type'] = 'application/json';
    config.body = JSON.stringify(body);
  }

  let response;
  try {
    response = await fetch(`${BASE}${path}`, config);
  } catch {
    throw new ApiError('Tidak dapat terhubung ke server. / Cannot reach the server.', 0);
  }

  if (response.status === 401 && !silent401 && !path.startsWith('/auth/login')) {
    window.dispatchEvent(new CustomEvent('auth:logout'));
  }
  if (raw && response.ok) return response;

  const data = response.status === 204 ? {} : await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = Array.isArray(data.errors) && data.errors.length
      ? `: ${data.errors.map((e) => e.message || e.msg).filter(Boolean).slice(0, 3).join('; ')}`
      : '';
    throw new ApiError(`${data.message || 'Request failed'}${detail}`, response.status, data.errors, data.code);
  }
  return data;
}

/** Download a server-generated file (CSV/XLSX/PDF) without exposing credentials. */
export async function download(path, params = {}) {
  const res = await request('GET', `${path}${qs(params)}`, null, { raw: true });
  const blob = await res.blob();
  const cd = res.headers.get('Content-Disposition') || '';
  const name = (cd.match(/filename="([^"]+)"/) || [])[1] || 'export';
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ── Auth ──────────────────────────────────────────────────────────────────────
export const auth = {
  login:      (data) => request('POST', '/auth/login', data),
  register:   (data) => request('POST', '/auth/register', data),
  logout:     ()     => request('POST', '/auth/logout'),
  logoutAll:  ()     => request('POST', '/auth/logout-all'),
  me:         ()     => request('GET', '/auth/me', null, { silent401: true }),
  session:    ()     => request('GET', '/auth/session'),
  changePassword: (d) => request('POST', '/auth/password', d),
  setup2fa:   ()     => request('POST', '/auth/2fa/setup'),
  enable2fa:  (code) => request('POST', '/auth/2fa/enable', { code }),
  disable2fa: (d)    => request('POST', '/auth/2fa/disable', d),
};

export const users = {
  me:     ()     => request('GET', '/users/me'),
  update: (data) => request('PATCH', '/users/me', data),
};

export const organisations = {
  list:         ()          => request('GET', '/organisations'),
  get:          (id)        => request('GET', `/organisations/${id}`),
  create:       (data)      => request('POST', '/organisations', data),
  update:       (id, data)  => request('PATCH', `/organisations/${id}`, data),
  members:      (id)        => request('GET', `/organisations/${id}/members`),
  addMember:    (id, d)     => request('POST', `/organisations/${id}/members`, d),
  updateMember: (id, uid, d) => request('PATCH', `/organisations/${id}/members/${uid}`, d),
  permissions:  ()          => request('GET', '/organisations/permissions'),
};

// ── Stocks ────────────────────────────────────────────────────────────────────
export const portfolios = {
  list:        (orgId) => request('GET', `/portfolios${qs({ orgId })}`),
  get:         (id)    => request('GET', `/portfolios/${id}`),
  create:      (data)  => request('POST', '/portfolios', data),
  update:      (id, d) => request('PUT', `/portfolios/${id}`, d),
  delete:      (id)    => request('DELETE', `/portfolios/${id}`),
  holdings:    (id)    => request('GET', `/portfolios/${id}/holdings`),
  performance: (id, p) => request('GET', `/portfolios/${id}/performance${qs(p)}`),
};

export const instruments = {
  list:      (params = {}) => request('GET', `/instruments${qs(params)}`),
  get:       (id)          => request('GET', `/instruments/${id}`),
  prices:    (id, params)  => request('GET', `/instruments/${id}/prices${qs(params)}`),
  exchanges: ()            => request('GET', '/instruments/exchanges'),
};

export const transactions = {
  list:   (params = {}) => request('GET', `/transactions${qs(params)}`),
  create: (data)        => request('POST', '/transactions', data),
  update: (id, data)    => request('PUT', `/transactions/${id}`, data),
  delete: (id, reason)  => request('DELETE', `/transactions/${id}${qs({ reason })}`),
};

export const watchlists = {
  list:       ()                 => request('GET', '/watchlists'),
  create:     (data)             => request('POST', '/watchlists', data),
  remove:     (id)               => request('DELETE', `/watchlists/${id}`),
  items:      (id)               => request('GET', `/watchlists/${id}/items`),
  addItem:    (id, instrumentId) => request('POST', `/watchlists/${id}/items`, { instrumentId }),
  removeItem: (id, instrumentId) => request('DELETE', `/watchlists/${id}/items/${instrumentId}`),
};

export const prices = {
  latest: (symbols) => request('GET', `/prices/latest${qs({ symbols: symbols.join(',') })}`),
};

// ── Franchise ─────────────────────────────────────────────────────────────────
export const franchise = {
  dashboard:  (params) => request('GET', `/franchise/dashboard${qs(params)}`),
  comparison: (params) => request('GET', `/franchise/comparison${qs(params)}`),
  trends:     (params) => request('GET', `/franchise/trends${qs(params)}`),
  lowStock:   (params) => request('GET', `/franchise/low-stock${qs(params)}`),
};

export const brands = {
  list:   (orgId) => request('GET', `/brands${qs({ orgId })}`),
  create: (data)  => request('POST', '/brands', data),
  update: (id, d) => request('PUT', `/brands/${id}`, d),
};

export const regions = {
  list:   (params) => request('GET', `/regions${qs(params)}`),
  create: (data)   => request('POST', '/regions', data),
};

export const outlets = {
  list:        (params) => request('GET', `/outlets${qs(params)}`),
  get:         (id)     => request('GET', `/outlets/${id}`),
  create:      (data)   => request('POST', '/outlets', data),
  update:      (id, d)  => request('PUT', `/outlets/${id}`, d),
  summary:     (id, p)  => request('GET', `/outlets/${id}/summary${qs(p)}`),
  assignments: (id)     => request('GET', `/outlets/${id}/assignments`),
  assign:      (id, d)  => request('POST', `/outlets/${id}/assignments`, d),
};

export const sales = {
  list:   (params) => request('GET', `/sales${qs(params)}`),
  create: (data)   => request('POST', '/sales', data),
  update: (id, d)  => request('PUT', `/sales/${id}`, d),
  delete: (id, reason) => request('DELETE', `/sales/${id}${qs({ reason })}`),
};

export const expenses = {
  list:           (params) => request('GET', `/expenses${qs(params)}`),
  categories:     (orgId)  => request('GET', `/expenses/categories${qs({ orgId })}`),
  createCategory: (data)   => request('POST', '/expenses/categories', data),
  create:         (data)   => request('POST', '/expenses', data),
  update:         (id, d)  => request('PUT', `/expenses/${id}`, d),
  delete:         (id, reason) => request('DELETE', `/expenses/${id}${qs({ reason })}`),
};

export const products = {
  list:   (params) => request('GET', `/products${qs(params)}`),
  create: (data)   => request('POST', '/products', data),
  update: (id, d)  => request('PUT', `/products/${id}`, d),
};

export const inventory = {
  balances:    (params) => request('GET', `/inventory${qs(typeof params === 'string' ? { outletId: params } : params)}`),
  movements:   (params) => request('GET', `/inventory/movements${qs(params)}`),
  addMovement: (data)   => request('POST', '/inventory/movements', data),
  transfer:    (data)   => request('POST', '/inventory/transfers', data),
};

export const targets = {
  list:   (params) => request('GET', `/targets${qs(params)}`),
  create: (data)   => request('POST', '/targets', data),
  delete: (id)     => request('DELETE', `/targets/${id}`),
};

export const approvals = {
  list:    (params) => request('GET', `/approvals${qs(params)}`),
  approve: (id, notes) => request('POST', `/approvals/${id}/approve`, { notes }),
  reject:  (id, notes) => request('POST', `/approvals/${id}/reject`, { notes }),
};

// ── Reports / imports / exports ───────────────────────────────────────────────
export const reports = {
  franchisePnl:  (params) => request('GET', `/reports/franchise/pnl${qs(params)}`),
  comparison:    (params) => request('GET', `/reports/franchise/comparison${qs(params)}`),
  stockOverview: (params) => request('GET', `/reports/stocks/overview${qs(params)}`),
};

export const imports = {
  entities: ()          => request('GET', '/imports/entities'),
  list:     (params)    => request('GET', `/imports${qs(params)}`),
  get:      (id)        => request('GET', `/imports/${id}`),
  upload:   (entityType, context, file) => {
    const form = new FormData();
    form.append('entityType', entityType);
    for (const [k, v] of Object.entries(context)) form.append(k, v);
    form.append('file', file);
    return request('POST', '/imports', null, { form });
  },
  validate: (id, mapping) => request('POST', `/imports/${id}/validate`, { mapping }),
  confirm:  (id)          => request('POST', `/imports/${id}/confirm`),
  cancel:   (id)          => request('POST', `/imports/${id}/cancel`),
  errorReport: (id)       => download(`/imports/${id}/errors.csv`),
  template:    (entity)   => download(`/imports/templates/${entity}`),
};

export const exportsApi = {
  download: (dataset, params) => download(`/exports/${dataset}`, params),
};

export const auditApi = {
  list: (params) => request('GET', `/audit${qs(params)}`),
};

export const integrations = {
  status:     () => request('GET', '/integrations/status'),
  syncPrices: () => request('POST', '/integrations/market-data/sync'),
  syncFx:     () => request('POST', '/integrations/currency/sync'),
};

export const admin = {
  stats:     ()          => request('GET', '/admin/stats'),
  users:     (params)    => request('GET', `/admin/users${qs(params)}`),
  setUser:   (id, d)     => request('PATCH', `/admin/users/${id}`, d),
  orgs:      ()          => request('GET', '/admin/organisations'),
  setOrg:    (id, d)     => request('PATCH', `/admin/organisations/${id}`, d),
  audit:     (params)    => request('GET', `/admin/audit${qs(params)}`),
  jobs:      ()          => request('GET', '/admin/jobs'),
  settings:  ()          => request('GET', '/admin/settings'),
  setSetting:(key, value) => request('PUT', `/admin/settings/${key}`, { value }),
};

/** Deprecated shims kept so older page code keeps working. */
export function setToken() {}
export function getToken() { return null; }
