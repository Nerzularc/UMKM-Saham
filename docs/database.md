# Database

PostgreSQL. Migrations are plain SQL files in `server/src/database/migrations`,
applied in filename order by `npm run db:migrate` inside one transaction and
recorded in `schema_migrations`. After migrating, the permission matrix from
`services/permissions.js` is mirrored into `permissions`/`role_permissions`.

## Conventions

| Topic | Convention |
|---|---|
| Keys | `UUID` primary keys (`uuid_generate_v4()`), `BIGSERIAL` for high-volume series |
| Money | `NUMERIC(20,2)`; prices `NUMERIC(20,6)`; quantities `NUMERIC(20,8)`; FX `NUMERIC(20,8)` |
| Currency | ISO-4217 `VARCHAR(3)` next to every amount |
| Time | `TIMESTAMPTZ` for events, `DATE` for business days |
| Tenancy | tenant-owned rows carry `org_id` directly or via `outlets.org_id`; personal rows carry `user_id` |
| Soft delete | `deleted_at` on records users may delete (transactions, sales, expenses, portfolios, outlets…) |
| Demo data | `is_demo` on instruments/prices/FX/transactions; `source = 'demo_seed'` on franchise rows |
| Idempotent imports | `source_hash` + partial unique index on imported tables |

## Tables by domain

**Identity & tenancy (001, 005):** `users`, `organisations` (`modules_enabled`,
`settings` JSON incl. approvals), `roles`, `permissions`, `role_permissions`,
`org_memberships`, `sessions` (one row per issued token; `revoked_at`),
`audit_events` (append-only via trigger), `platform_settings`.

**Stocks (002, 005):** `exchanges`, `instruments` (`provider_symbol`, `last_price`,
`last_price_at`, `price_source`, `is_demo`), `price_observations` (unique per
instrument/day), `exchange_rates` (unique per pair/day), `portfolios`
(`cost_basis_method` WAC|FIFO, `portfolio_type` tracking|simulation),
`portfolio_transactions` (ledger; check constraints on type, quantity, fee),
`watchlists`, `watchlist_items`, `corporate_actions`, `broker_connections`.

**Franchise (003, 005):** `brands`, `regions`, `outlets`, `outlet_assignments`
(scope for managers/staff), `expense_categories` (platform defaults + per-org chart of
accounts; `category_type` cogs|operating|non_operating|tax), `products`,
`inventory_balances`, `inventory_movements` (signed quantity, `transfer_id`),
`sales_records` (`net_sales` is a generated column), `operating_expenses`, `targets`
(unique per scope/period).

**Operations (004, 005):** `import_batches` (headers, parsed rows until completion,
mapping, counts, file hash), `import_row_errors`, `change_approvals`,
`integration_connections`, `sync_jobs`.

## Indexes worth knowing

- `sales_records (outlet_id, sale_date DESC) WHERE deleted_at IS NULL` — every report
- `portfolio_transactions (portfolio_id, transaction_date DESC)` — holdings rebuild
- `price_observations (instrument_id, price_date DESC)` — valuation history
- `audit_events (org_id, created_at DESC)`, `(actor_id, created_at DESC)`

## Price history retention

Daily observations only (one row per instrument per day). At ~260 trading days ×
N instruments the table stays small; partitioning by year is the natural next step
if intraday data is ever stored.

## Backups

See [local-development.md](local-development.md#backup-and-restore).
