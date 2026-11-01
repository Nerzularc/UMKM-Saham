# Local development

## Requirements
- Node.js 20 or newer (tested with 22) and npm 10
- PostgreSQL 15/16 — via Docker (recommended) or a local installation
- Windows, macOS and Linux are supported (all scripts are Node-based)

## 1. Install and configure
```bash
npm install
npm run setup          # creates .env and generates JWT_SECRET / TOTP_ENCRYPTION_KEY
```

## 2. Start PostgreSQL

**Docker:**
```bash
docker compose up -d   # creates umkm_saham and umkm_saham_test on first start
```

**Without Docker** (local PostgreSQL), as a superuser:
```sql
CREATE USER umkm_user WITH PASSWORD 'umkm_dev_password' CREATEDB;
CREATE DATABASE umkm_saham OWNER umkm_user;
CREATE DATABASE umkm_saham_test OWNER umkm_user;
```
Then make sure `DATABASE_URL` in `.env` points to it. The migrations create the
`uuid-ossp` and `pgcrypto` extensions (needs a role that may create extensions, or
create them once as superuser in both databases).

## 3. Schema and demo data
```bash
npm run db:migrate
npm run db:seed        # skips if already seeded
# start over:  npm run db:reset && npm run db:migrate && npm run db:seed
```

## 4. Run
```bash
npm run dev
```
- Web: http://localhost:5173 (Vite proxies `/api` to the API)
- API: http://localhost:3000/api/v1 · health: http://localhost:3000/api/v1/health

Production-style single origin:
```bash
npm run build && npm start   # http://localhost:3000 serves the SPA and the API
```

## Environment variables
See `.env.example` — every variable is documented there. Required: `DATABASE_URL`,
`JWT_SECRET` (random fallback in development only), `TOTP_ENCRYPTION_KEY`
(falls back to `JWT_SECRET`). All provider keys are optional.

## Tests
```bash
npm test                  # everything
npm run test:unit         # no database needed
npm run test:integration
npm run test:security
```
Integration and security tests **reset** the test database (`TEST_DATABASE_URL`, or
`<DB_NAME>_test`) before each run and refuse to touch a database whose name does not
end with `_test`. The database is created automatically if the user may create
databases.

## Backup and restore
```bash
npm run db:backup                                   # backups/<db>-YYYYMMDD-HHMMSS.dump
npm run db:restore -- backups/<file>.dump           # asks you to type the db name
RESTORE_DATABASE_URL=postgresql://…/scratch npm run db:restore -- <file> --yes
```
- Uses local `pg_dump`/`pg_restore` if installed, otherwise `docker exec` into the
  `umkm_saham_db` container.
- Custom-format dumps (compressed); restore runs `--clean --if-exists` in a single
  transaction, so a failed restore leaves the target unchanged.
- Retention: the newest `BACKUP_RETENTION` (default 14) dumps are kept.
- Verified procedure: backup → restore into an empty database and into a populated
  one → identical row counts and checksums, audit trigger present.
- Schedule backups with Windows Task Scheduler or cron, e.g. daily
  `cd <repo> && npm run db:backup`. Copy `backups/` off the machine; a backup on the
  same disk is not disaster recovery.

## Troubleshooting
| Symptom | Fix |
|---|---|
| `no PostgreSQL user name specified` | run from the repo root; `.env` must exist there (`npm run setup`) |
| `ECONNREFUSED 5432` | start PostgreSQL (`docker compose up -d`) |
| Port 5432 already used | change `DB_PORT` and `DATABASE_URL` |
| Logged out after restarting the API | set `JWT_SECRET` in `.env` (`npm run setup`) |
| Tests fail creating the test DB | create `umkm_saham_test` manually (see above) |
