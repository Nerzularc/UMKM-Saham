-- ============================================================================
-- Migration 005: Security hardening, idempotent imports, approvals settings,
--                simulated portfolios and data-integrity constraints
-- ============================================================================

-- ── Organisation settings (approvals, reporting) ──────────────────────────────
ALTER TABLE organisations
  ADD COLUMN IF NOT EXISTS settings JSONB NOT NULL DEFAULT
    '{"approvals":{"enabled":false,"separationOfDuties":true,"actions":["sales.update","sales.delete","expenses.update","expenses.delete"]}}';

-- ── Sessions: one row per issued token (id = JWT jti) ─────────────────────────
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS revoked_at TIMESTAMPTZ;

-- ── Two-factor: pending secret during enrolment ───────────────────────────────
ALTER TABLE users ADD COLUMN IF NOT EXISTS two_factor_pending_secret TEXT;

-- ── Portfolios: tracking (real records) vs simulation (paper trading) ─────────
ALTER TABLE portfolios
  ADD COLUMN IF NOT EXISTS portfolio_type VARCHAR(20) NOT NULL DEFAULT 'tracking';
ALTER TABLE portfolios
  ADD CONSTRAINT chk_portfolio_type CHECK (portfolio_type IN ('tracking', 'simulation'));
ALTER TABLE portfolios
  ADD CONSTRAINT chk_cost_basis_method CHECK (cost_basis_method IN ('WAC', 'FIFO'));

-- ── Portfolio transactions ────────────────────────────────────────────────────
ALTER TABLE portfolio_transactions ADD COLUMN IF NOT EXISTS source_hash TEXT;
ALTER TABLE portfolio_transactions ADD COLUMN IF NOT EXISTS is_simulated BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE portfolio_transactions
  ADD CONSTRAINT chk_ptxn_type CHECK (transaction_type IN
    ('buy','sell','dividend','deposit','withdrawal','fee','split'));
ALTER TABLE portfolio_transactions
  ADD CONSTRAINT chk_ptxn_fee CHECK (fee >= 0);
ALTER TABLE portfolio_transactions
  ADD CONSTRAINT chk_ptxn_qty CHECK (
    transaction_type NOT IN ('buy','sell','split') OR (quantity IS NOT NULL AND quantity > 0));
CREATE UNIQUE INDEX IF NOT EXISTS uq_ptxn_source_hash
  ON portfolio_transactions (portfolio_id, source_hash)
  WHERE source_hash IS NOT NULL AND deleted_at IS NULL;

-- ── Franchise records: non-negative amounts + idempotent import keys ─────────
ALTER TABLE sales_records ADD COLUMN IF NOT EXISTS source_hash TEXT;
ALTER TABLE sales_records
  ADD CONSTRAINT chk_sales_non_negative CHECK
    (gross_sales >= 0 AND discounts >= 0 AND returns >= 0 AND transaction_count >= 0);
CREATE UNIQUE INDEX IF NOT EXISTS uq_sales_source_hash
  ON sales_records (outlet_id, source_hash)
  WHERE source_hash IS NOT NULL AND deleted_at IS NULL;

ALTER TABLE operating_expenses ADD COLUMN IF NOT EXISTS source_hash TEXT;
ALTER TABLE operating_expenses
  ADD CONSTRAINT chk_expense_non_negative CHECK (amount >= 0);
CREATE UNIQUE INDEX IF NOT EXISTS uq_expense_source_hash
  ON operating_expenses (outlet_id, source_hash)
  WHERE source_hash IS NOT NULL AND deleted_at IS NULL;

ALTER TABLE inventory_movements ADD COLUMN IF NOT EXISTS source_hash TEXT;
ALTER TABLE inventory_movements ADD COLUMN IF NOT EXISTS transfer_id UUID;
CREATE UNIQUE INDEX IF NOT EXISTS uq_inv_movement_source_hash
  ON inventory_movements (outlet_id, source_hash)
  WHERE source_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_inv_movement_transfer ON inventory_movements (transfer_id);

CREATE UNIQUE INDEX IF NOT EXISTS uq_products_org_sku
  ON products (org_id, sku) WHERE sku IS NOT NULL AND deleted_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_targets_scope_period
  ON targets (org_id,
              COALESCE(brand_id,  '00000000-0000-0000-0000-000000000000'),
              COALESCE(region_id, '00000000-0000-0000-0000-000000000000'),
              COALESCE(outlet_id, '00000000-0000-0000-0000-000000000000'),
              target_type, period_type, period_year, COALESCE(period_value, 0));

-- ── Import batches: file fingerprint, parsed rows and context ─────────────────
ALTER TABLE import_batches ADD COLUMN IF NOT EXISTS file_hash TEXT;
ALTER TABLE import_batches ADD COLUMN IF NOT EXISTS headers JSONB;
ALTER TABLE import_batches ADD COLUMN IF NOT EXISTS parsed_rows JSONB;
ALTER TABLE import_batches ADD COLUMN IF NOT EXISTS context JSONB;
ALTER TABLE import_batches ADD COLUMN IF NOT EXISTS duplicate_rows INTEGER NOT NULL DEFAULT 0;

-- ── Platform settings (superadmin feature configuration) ──────────────────────
CREATE TABLE IF NOT EXISTS platform_settings (
  key         VARCHAR(100) PRIMARY KEY,
  value       JSONB NOT NULL,
  updated_by  UUID REFERENCES users (id),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO platform_settings (key, value) VALUES
  ('registration_enabled', 'true'),
  ('maintenance_banner',   '""')
ON CONFLICT (key) DO NOTHING;

-- ── Audit trail is append-only ────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION prevent_audit_mutation()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'audit_events is append-only';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS audit_events_no_update ON audit_events;
CREATE TRIGGER audit_events_no_update
  BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE PROCEDURE prevent_audit_mutation();
