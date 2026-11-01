# REST API (v1)

Base URL `/api/v1`. JSON in, JSON out.

**Success:** `{ "success": true, "data": …, "meta"?: { total, page, limit, totalPages, … } }`
**Error:** `{ "success": false, "message": "…", "errors"?: [{ field, message }], "code"?: "…" }`

| Status | Meaning |
|---|---|
| 400 | malformed identifier, date or JSON |
| 401 | not signed in / session revoked (`code: TOTP_REQUIRED` when a 2FA code is needed) |
| 403 | signed in but not permitted (also missing/invalid CSRF token) |
| 404 | not found **or belongs to another tenant** (no existence leaks) |
| 409 | duplicate / already processed |
| 413 / 415 | upload too large / unsupported file type |
| 422 | business validation failed (e.g. overselling, discounts > gross) |
| 202 | change submitted for approval instead of applied |

Pagination: `?page=1&limit=50` (bounded). Sorting where supported:
`?sort=<whitelisted key>&order=asc|desc`. Dates: `YYYY-MM-DD`, inclusive.

## Authentication

Browsers use the HTTP-only `token` cookie set by `POST /auth/login`. Every
non-GET request authenticated by cookie must send `X-CSRF-Token` equal to the
readable `csrf_token` cookie. Non-browser clients may send
`Authorization: Bearer <token>` instead (not CSRF-exposed).

| Method | Path | Notes |
|---|---|---|
| POST | `/auth/register` | `{ email, password, fullName, locale? }` (disabled via platform setting) |
| POST | `/auth/login` | `{ email, password, totp? }` → sets cookies; rate limited; lockout after 5 failures |
| GET | `/auth/session` | `{ user \| null }` (never 401) |
| GET | `/auth/me` | current user + memberships |
| POST | `/auth/logout`, `/auth/logout-all` | revoke this / every session |
| POST | `/auth/password` | `{ currentPassword, newPassword }` → revokes all sessions |
| POST | `/auth/2fa/setup` · `/2fa/enable` · `/2fa/disable` | TOTP enrolment |

## Stocks

| Method | Path | Notes |
|---|---|---|
| GET/POST | `/portfolios` | `?orgId=` lists org portfolios (owner/manager) |
| GET/PUT/DELETE | `/portfolios/:id` | base currency locked once transactions exist |
| GET | `/portfolios/:id/holdings` | holdings, summary, allocation, warnings |
| GET | `/portfolios/:id/performance?from&to` | value series, `twrPct`, `mwrPct`, note codes |
| GET/POST | `/transactions` | filters: `portfolioId, type, instrumentId, from, to` |
| PUT/DELETE | `/transactions/:id` | PUT requires `reason`; ledger consistency enforced |
| GET | `/instruments`, `/instruments/:id`, `/instruments/:id/prices`, `/instruments/exchanges` | |
| POST | `/instruments` | superadmin catalogue maintenance |
| GET | `/prices/latest?symbols=BBCA,AAPL` | includes `price_stale`, `is_demo` |
| CRUD | `/watchlists`, `/watchlists/:id/items` | owner only |

## Franchise

All list endpoints accept `orgId` (scoped to the caller's outlets) or `outletId`.

| Method | Path | Notes |
|---|---|---|
| GET | `/franchise/dashboard` | `orgId, from, to, brandId, regionId, outletId, status` |
| GET | `/franchise/comparison`, `/franchise/trends`, `/franchise/low-stock` | |
| GET/POST/PUT | `/brands`, `/regions`, `/outlets`, `/products` | writes need `franchise.structure.manage` |
| GET/POST | `/outlets/:id/summary`, `/outlets/:id/assignments` | |
| GET/POST/PUT/DELETE | `/sales`, `/expenses` | PUT/DELETE may return 202 (approval) |
| GET/POST | `/expenses/categories` | org chart of accounts |
| GET | `/inventory`, `/inventory/movements` | |
| POST | `/inventory/movements`, `/inventory/transfers` | negative stock rejected |
| GET/POST/DELETE | `/targets` | upsert by scope + period |
| GET | `/approvals?orgId=`; POST `/approvals/:id/approve|reject` | |

## Imports & exports

| Method | Path | Notes |
|---|---|---|
| GET | `/imports/entities`, `/imports/templates/:entity` | `sales, expenses, inventory, stock_transactions` |
| POST | `/imports` | multipart: `file`, `entityType`, `orgId` or `portfolioId` |
| POST | `/imports/:id/validate` | `{ mapping: { field: "Header" } }` |
| POST | `/imports/:id/confirm` | one DB transaction; idempotent |
| GET | `/imports`, `/imports/:id`, `/imports/:id/errors.csv` | |
| GET | `/exports/:dataset?format=csv|xlsx|pdf` | `stock-transactions, stock-holdings, franchise-pnl, outlet-comparison, sales, expenses, inventory, audit` |

## Reports, audit, admin, integrations

| Method | Path |
|---|---|
| GET | `/reports/franchise/pnl`, `/reports/franchise/comparison`, `/reports/stocks/overview` |
| GET | `/audit` (own actions) · `/audit?orgId=` (needs `org.audit.read`) |
| GET/PATCH | `/organisations[/:orgId]`, `/organisations/:orgId/members[/:userId]`, `/organisations/permissions` |
| GET/PATCH/PUT | `/admin/stats`, `/admin/users`, `/admin/organisations`, `/admin/audit`, `/admin/jobs`, `/admin/settings/:key` |
| GET | `/integrations/status` |
| POST | `/integrations/market-data/sync`, `/integrations/currency/sync` (superadmin) |
| POST | `/integrations/brokers/orders` → always 501 in this release |

## Integrations

Adapters live in `server/src/modules/integrations/providers/`:

- `http.js` — timeout (`PROVIDER_TIMEOUT_MS`), retries with exponential backoff on
  429/5xx/network errors, minimum interval between calls, URL logging without query
  strings (API keys are never logged).
- `marketData.js` — `demo` (returns no quotes) and `alpha_vantage` (`GLOBAL_QUOTE`).
- `currency.js` — `demo` and `exchangerate_api`.
- `brokers.js` — interface description and registry (empty; CSV statement import only).

Every sync run is recorded in `sync_jobs` (status, counts, failures, unmapped
symbols). Prices written by a live provider set `is_demo = false` and
`price_source` to the provider name; the UI shows the timestamp and a stale flag
(older than 24 h).
