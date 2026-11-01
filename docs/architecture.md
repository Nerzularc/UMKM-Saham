# Architecture

UMKM Saham is a **modular monolith**: one Express process and one PostgreSQL
database, with business domains separated into modules that share a small core.

```
Browser (Vite SPA, vanilla JS)
   │  HTTP-only session cookie + X-CSRF-Token
   ▼
Express app (server/src/app.js)
   ├─ middleware: helmet, CORS, JSON limits, rate limits, request logging
   ├─ requireAuth  → session lookup (sessions table, revocable) → req.user, req.memberships
   ├─ modules/<domain>/*.routes.js   — thin HTTP layer + validation (express-validator)
   │     └─ services (permissions, financial calculations, franchise reporting, imports)
   └─ errorHandler — maps DB/validation errors, never leaks internals
   ▼
PostgreSQL (NUMERIC money, constraints, append-only audit trigger)

jobs/ (node-cron) — market-data + FX sync, session cleanup (disabled in tests)
```

## Modules

| Module | Responsibility |
|---|---|
| `auth` | registration, login, sessions, logout (one/all), password change, TOTP 2FA |
| `tenants` | organisations, settings (modules, timezone, approvals), members |
| `stocks` | portfolios, instruments, transactions, watchlists, prices, holdings & performance |
| `franchise` | brands, regions, outlets, assignments, sales, expenses, products, inventory, targets, dashboards |
| `imports` | upload → map → validate → confirm workflow for 4 entity types |
| `reports` | P&L / comparison / stock overview reports and CSV/XLSX/PDF exports |
| `approvals` | maker-checker workflow for configured financial changes |
| `audit` | append-only audit log and query API |
| `admin` | superadmin console (platform health, users, orgs, settings, jobs, security events) |
| `integrations` | provider adapters (market data, FX, brokers), status, manual sync |

Stock logic and franchise logic never import each other. Shared code lives in
`services/permissions.js` (authorisation), `services/financialCalculations.js`
(pure maths, unit-tested), `utils/` and `modules/audit`.

## Key design decisions

- **Ledger first.** Holdings, cash and returns are recomputed from transactions on
  every request — no stored derived positions that could drift.
- **Decimal arithmetic.** All money is `NUMERIC` in the DB and `decimal.js` in code;
  API responses round to 2 decimals (money) / 6–8 (prices, quantities).
- **Dates are calendar dates.** `DATE` columns are returned as `YYYY-MM-DD` strings
  (pg type parser) and every report uses inclusive `BETWEEN from AND to`, so charts,
  tables and exports share boundaries. "Today" is resolved in the organisation's
  timezone (default Asia/Jakarta).
- **Authorisation in one place.** Routes call `requirePermission`, `franchiseContext`,
  `assertOutletAccess`, `getPortfolio` — no role-name comparisons scattered around.
- **Provider adapters.** Market data/FX adapters implement a tiny interface; the demo
  adapter returns `null` rather than fabricating prices.
- **Single origin in production.** `npm run build && npm start` serves the SPA from
  Express, so cookies stay same-site.

## Frontend

- `components/ui.js` provides an `html` tagged template that HTML-escapes every
  interpolated value (XSS protection by default), plus modals, confirmations,
  filters, period pickers, pagination and export buttons.
- `app/router.js` is a hash router; it hides routes the user cannot use (UX only —
  the API enforces everything again).
- All visible strings come from `i18n/messages.js` (Indonesian default, English).
