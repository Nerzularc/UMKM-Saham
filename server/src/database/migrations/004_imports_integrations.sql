-- ============================================================================
-- Migration 004: Import/export jobs and approval workflows
-- ============================================================================

-- ── Import batches ────────────────────────────────────────────────────────────
CREATE TABLE import_batches (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id          UUID REFERENCES organisations (id) ON DELETE CASCADE,
  user_id         UUID NOT NULL REFERENCES users (id),
  module          VARCHAR(20) NOT NULL,   -- stocks | franchise
  entity_type     VARCHAR(50) NOT NULL,  -- transactions | sales | expenses | inventory
  filename        VARCHAR(500),
  file_size       INTEGER,
  total_rows      INTEGER NOT NULL DEFAULT 0,
  valid_rows      INTEGER NOT NULL DEFAULT 0,
  imported_rows   INTEGER NOT NULL DEFAULT 0,
  error_rows      INTEGER NOT NULL DEFAULT 0,
  status          VARCHAR(20) NOT NULL DEFAULT 'pending',
  -- pending | validating | preview | confirmed | importing | done | failed | cancelled
  preview_data    JSONB,
  column_mapping  JSONB,
  started_at      TIMESTAMPTZ,
  completed_at    TIMESTAMPTZ,
  error_message   TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_import_batches_org  ON import_batches (org_id, created_at DESC);
CREATE INDEX idx_import_batches_user ON import_batches (user_id);

CREATE TRIGGER set_import_batches_updated_at
  BEFORE UPDATE ON import_batches
  FOR EACH ROW EXECUTE PROCEDURE trigger_set_updated_at();

-- ── Import row errors ─────────────────────────────────────────────────────────
CREATE TABLE import_row_errors (
  id          BIGSERIAL PRIMARY KEY,
  batch_id    UUID NOT NULL REFERENCES import_batches (id) ON DELETE CASCADE,
  row_number  INTEGER NOT NULL,
  column_name VARCHAR(100),
  error_code  VARCHAR(100),
  message     TEXT NOT NULL,
  raw_data    JSONB
);

CREATE INDEX idx_import_errors_batch ON import_row_errors (batch_id);

-- ── Financial change approvals ────────────────────────────────────────────────
CREATE TABLE change_approvals (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id            UUID NOT NULL REFERENCES organisations (id) ON DELETE CASCADE,
  resource_type     VARCHAR(100) NOT NULL,
  resource_id       UUID NOT NULL,
  action            VARCHAR(50) NOT NULL,  -- update | delete | reversal
  old_values        JSONB,
  new_values        JSONB,
  reason            TEXT,
  status            VARCHAR(20) NOT NULL DEFAULT 'pending',
  -- pending | approved | rejected | cancelled
  requested_by      UUID NOT NULL REFERENCES users (id),
  reviewed_by       UUID REFERENCES users (id),
  reviewed_at       TIMESTAMPTZ,
  review_notes      TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_approvals_org    ON change_approvals (org_id, status);
CREATE INDEX idx_approvals_status ON change_approvals (status, created_at DESC);

CREATE TRIGGER set_approvals_updated_at
  BEFORE UPDATE ON change_approvals
  FOR EACH ROW EXECUTE PROCEDURE trigger_set_updated_at();

-- ── Integration connections ───────────────────────────────────────────────────
CREATE TABLE integration_connections (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id          UUID REFERENCES organisations (id) ON DELETE CASCADE,
  user_id         UUID REFERENCES users (id) ON DELETE CASCADE,
  provider        VARCHAR(50) NOT NULL,
  integration_type VARCHAR(30) NOT NULL,  -- market_data | currency | pos | broker
  display_name    VARCHAR(255),
  status          VARCHAR(20) NOT NULL DEFAULT 'inactive',
  config          JSONB,
  last_used_at    TIMESTAMPTZ,
  last_error      TEXT,
  error_count     INTEGER NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TRIGGER set_integrations_updated_at
  BEFORE UPDATE ON integration_connections
  FOR EACH ROW EXECUTE PROCEDURE trigger_set_updated_at();

-- ── Sync jobs ─────────────────────────────────────────────────────────────────
CREATE TABLE sync_jobs (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  integration_id  UUID REFERENCES integration_connections (id),
  job_type        VARCHAR(50) NOT NULL,
  status          VARCHAR(20) NOT NULL DEFAULT 'pending',
  started_at      TIMESTAMPTZ,
  completed_at    TIMESTAMPTZ,
  records_synced  INTEGER,
  error_message   TEXT,
  metadata        JSONB,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_sync_jobs_integration ON sync_jobs (integration_id, created_at DESC);
CREATE INDEX idx_sync_jobs_status      ON sync_jobs (status, created_at DESC);
