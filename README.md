# UMKM Saham — Unified Stock Market & Franchise Management Platform

One application for **investment portfolio management** (IDX, US and other markets
supported by the configured data provider) and **franchise performance reporting**
(organisation → brand → region → outlet), with one login, multi-tenant isolation,
Indonesian/English UI and IDR as the default reporting currency.

> **Demo data notice.** Out of the box the app runs in *demo mode*: every seeded
> price, exchange rate, sale and expense is synthetic and labelled `DEMO`. No live
> market data is shown unless a provider key is configured, and live order
> execution is never available.

---

## Ringkasan cepat (Bahasa Indonesia)

```bash
npm install                 # pasang dependensi (sekali)
npm run setup               # buat .env + secret acak
docker compose up -d        # jalankan PostgreSQL (atau pakai PostgreSQL lokal)
npm run db:migrate          # buat skema database
npm run db:seed             # isi data demo
npm run dev                 # API :3000 + web :5173
```

Buka **http://localhost:5173** lalu klik salah satu tombol akun demo
(kata sandi `Demo@1234`, hanya untuk pengembangan lokal).

---

## Stack

| Layer | Technology |
|---|---|
| Frontend | Vanilla HTML/CSS/JS (ES modules), Tailwind CSS 3 (compiled by Vite/PostCSS), Chart.js 4 |
| Backend | Node.js ≥ 20, Express 4 (ES modules), REST API under `/api/v1` |
| Database | PostgreSQL 15/16, SQL migrations, `pg` with parameterised queries |
| Money maths | `decimal.js` + PostgreSQL `NUMERIC` (never binary floats for stored values) |
| Imports/exports | `csv-parse`, `exceljs`, `pdfkit` |
| Tests | Jest + Supertest against a real PostgreSQL test database |

Architecture: modular monolith — see [docs/architecture.md](docs/architecture.md).

## Repository layout

```
├── client/                     Vite + Tailwind SPA (no framework)
│   └── src/
│       ├── app/                router + application shell
│       ├── components/         ui.js (escaping html`` template, modals, filters), chart.js
│       ├── i18n/               t(), Intl formatting, messages.js (id + en)
│       ├── pages/              auth, dashboard, stocks, franchise, reports, imports, settings
│       ├── services/api.js     fetch wrapper (cookie session + CSRF header)
│       └── state/              store + session helpers
├── server/
│   ├── src/
│   │   ├── app.js / server.js  Express app factory / process entry point
│   │   ├── config/             env loader (root .env), PostgreSQL pool
│   │   ├── database/           migrate.js, seed.js, reset.js, migrations/*.sql
│   │   ├── middleware/         auth (session + CSRF), validation, errors, logging
│   │   ├── services/           financialCalculations.js, permissions.js
│   │   ├── modules/            auth, users, tenants, stocks, franchise, imports,
│   │   │                       reports (+exports), approvals, audit, admin, integrations
│   │   ├── jobs/               price/FX sync jobs + cron scheduler
│   │   └── utils/              dates, pagination, TOTP, errors, logger
│   └── tests/                  unit/, integration/, security/ (+ helpers, globalSetup)
├── scripts/                    setup.mjs, backup.mjs, restore.mjs, init-db.sql
├── docs/                       architecture, database, api, security, formulas, local-development
├── docker-compose.yml          PostgreSQL
└── .env.example
```

## Running locally

Full guide (including running without Docker): [docs/local-development.md](docs/local-development.md).

| Command | What it does |
|---|---|
| `npm run setup` | create `.env` and generate `JWT_SECRET` / `TOTP_ENCRYPTION_KEY` |
| `npm run db:migrate` | apply SQL migrations (idempotent, tracked in `schema_migrations`) |
| `npm run db:seed` | load demonstration data (skips if already present) |
| `npm run db:reset` | drop and recreate the schema (refuses in production) |
| `npm run dev` | API with nodemon on :3000 + Vite on :5173 (proxying `/api`) |
| `npm run build` | production frontend build → `client/dist` |
| `npm start` | API only; also serves `client/dist` if it exists (single origin on :3000) |
| `npm test` | unit + integration + security tests (resets the `_test` database) |
| `npm run db:backup` | `pg_dump` custom-format backup to `backups/` with retention |
| `npm run db:restore -- <file>` | restore a backup (asks for confirmation) |

URLs: web **http://localhost:5173** · API **http://localhost:3000/api/v1** ·
health **http://localhost:3000/api/v1/health**.

### Demo accounts (development only — password `Demo@1234`)

| Email | Role | What it demonstrates |
|---|---|---|
| `owner@demo.local` | Owner of *PT Demo Franchise* | full org access, settings, members, approvals, org portfolio |
| `manager@demo.local` | Manager | only the 4 Jabodetabek outlets (Bandung hidden) |
| `staff@demo.local` | Staff | one outlet, data entry/import, **no** profit figures or exports |
| `personal@demo.local` | Personal investor | IDX portfolio (WAC), US portfolio in IDR (FIFO, cash), simulation |
| `owner2@demo.local` | Owner of a second org | tenant isolation |
| `superadmin@demo.local` | Platform superadmin | users/orgs/jobs/security — no tenant financials |

## Features

**Stocks:** multiple portfolios per user (personal or organisation-owned), base
currency, WAC or FIFO per portfolio, buy/sell/dividend/deposit/withdrawal/fee/split,
oversell protection, FX conversion with stored or explicit rates, audited corrections
with mandatory reason, holdings with realised/unrealised P/L, dividends, cash, allocation
by instrument/sector/exchange/currency, value history, **time-weighted** and
**money-weighted** returns, portfolio comparison, watchlists with price history and
staleness flags, simulation (paper-trading) portfolios, CSV/XLSX/PDF exports,
broker-statement import.

**Franchise:** organisation → brand → region → outlet, outlet assignments, daily sales
(gross, discounts, returns, transactions), configurable chart of accounts (COGS,
operating, non-operating, tax), P&L, margins, ATV, growth vs. the previous equal
period, pro-rated targets (daily/weekly/monthly/yearly), underperforming-outlet flags,
inventory with movements, transfers, reorder alerts and valuation, dashboards scoped
to the user's role, monthly trends, outlet comparison, approval workflow with
separation of duties, CSV/Excel imports, CSV/XLSX/PDF exports.

**Platform:** cookie sessions with CSRF protection, optional TOTP 2FA, account lockout,
role/permission model with outlet scoping, append-only audit trail, superadmin console,
integration status and sync jobs, Indonesian/English UI, responsive layout.

## External integrations

| Integration | Status in this release | Configuration |
|---|---|---|
| Market data | Adapter for **Alpha Vantage** (delayed/EOD quotes). Only NYSE/NASDAQ symbols are mapped automatically; other markets (incl. IDX) sync only when an admin sets `instruments.provider_symbol` after verifying coverage. | `MARKET_DATA_PROVIDER=alpha_vantage`, `ALPHA_VANTAGE_API_KEY` |
| Exchange rates | Adapter for **ExchangeRate-API** (daily). | `CURRENCY_PROVIDER=exchangerate_api`, `EXCHANGERATE_API_KEY` |
| Broker | No broker API adapter ships (no public Indonesian broker API). Statements import via CSV/XLSX. Order endpoint returns 501. | — |
| POS | CSV/XLSX import of POS exports. No live POS adapter. | — |

The live adapters were tested with mocked HTTP responses (success, failure, timeout,
rate limit); they have **not** been exercised against the real services from this
environment. See [docs/api.md](docs/api.md#integrations).

## Tests

`npm test` runs **145** tests (unit, integration, security) against PostgreSQL. See
[docs/local-development.md](docs/local-development.md#tests) and the final test report
in the handoff notes.

## Known limitations

- Password reset by e-mail is not implemented (no mail provider); admins can reactivate
  accounts and users can change passwords when signed in.
- API validation messages are in English; the UI itself is fully bilingual.
- Corporate actions other than stock splits (rights issues, bonus shares) are not modelled.
- Live market data depends on the provider plan; demo prices are never refreshed.
- Exports are capped at 50,000 rows; imports at 10,000 rows / 10 MB per file.
