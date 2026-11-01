-- ============================================================================
-- Migration 003: Franchise management schema
-- ============================================================================

-- ── Brands ────────────────────────────────────────────────────────────────────
CREATE TABLE brands (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id        UUID NOT NULL REFERENCES organisations (id) ON DELETE CASCADE,
  name          VARCHAR(255) NOT NULL,
  code          VARCHAR(50),
  description   TEXT,
  logo_url      TEXT,
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at    TIMESTAMPTZ,
  UNIQUE (org_id, name)
);

CREATE INDEX idx_brands_org ON brands (org_id) WHERE deleted_at IS NULL;

CREATE TRIGGER set_brands_updated_at
  BEFORE UPDATE ON brands
  FOR EACH ROW EXECUTE PROCEDURE trigger_set_updated_at();

-- ── Regions ───────────────────────────────────────────────────────────────────
CREATE TABLE regions (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id        UUID NOT NULL REFERENCES organisations (id) ON DELETE CASCADE,
  brand_id      UUID REFERENCES brands (id) ON DELETE CASCADE,
  name          VARCHAR(255) NOT NULL,
  code          VARCHAR(50),
  description   TEXT,
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at    TIMESTAMPTZ
);

CREATE INDEX idx_regions_org   ON regions (org_id) WHERE deleted_at IS NULL;
CREATE INDEX idx_regions_brand ON regions (brand_id) WHERE deleted_at IS NULL;

CREATE TRIGGER set_regions_updated_at
  BEFORE UPDATE ON regions
  FOR EACH ROW EXECUTE PROCEDURE trigger_set_updated_at();

-- ── Outlets ───────────────────────────────────────────────────────────────────
CREATE TABLE outlets (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id            UUID NOT NULL REFERENCES organisations (id) ON DELETE CASCADE,
  brand_id          UUID NOT NULL REFERENCES brands (id),
  region_id         UUID REFERENCES regions (id),
  name              VARCHAR(255) NOT NULL,
  code              VARCHAR(50),
  address           TEXT,
  city              VARCHAR(100),
  province          VARCHAR(100),
  postal_code       VARCHAR(20),
  phone             VARCHAR(30),
  email             VARCHAR(320),
  opening_date      DATE,
  status            VARCHAR(20) NOT NULL DEFAULT 'active', -- active | inactive | closed | renovating
  reporting_currency VARCHAR(3) NOT NULL DEFAULT 'IDR',
  timezone          VARCHAR(50) NOT NULL DEFAULT 'Asia/Jakarta',
  is_active         BOOLEAN NOT NULL DEFAULT TRUE,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at        TIMESTAMPTZ
);

CREATE INDEX idx_outlets_org    ON outlets (org_id) WHERE deleted_at IS NULL;
CREATE INDEX idx_outlets_brand  ON outlets (brand_id) WHERE deleted_at IS NULL;
CREATE INDEX idx_outlets_region ON outlets (region_id) WHERE deleted_at IS NULL;

CREATE TRIGGER set_outlets_updated_at
  BEFORE UPDATE ON outlets
  FOR EACH ROW EXECUTE PROCEDURE trigger_set_updated_at();

-- ── Outlet staff assignments ──────────────────────────────────────────────────
CREATE TABLE outlet_assignments (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  outlet_id   UUID NOT NULL REFERENCES outlets (id) ON DELETE CASCADE,
  user_id     UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  role        VARCHAR(50) NOT NULL DEFAULT 'staff', -- manager | staff
  is_active   BOOLEAN NOT NULL DEFAULT TRUE,
  assigned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (outlet_id, user_id)
);

CREATE INDEX idx_outlet_assign_outlet ON outlet_assignments (outlet_id) WHERE is_active = TRUE;
CREATE INDEX idx_outlet_assign_user   ON outlet_assignments (user_id) WHERE is_active = TRUE;

-- ── Expense categories ────────────────────────────────────────────────────────
CREATE TABLE expense_categories (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id        UUID REFERENCES organisations (id) ON DELETE CASCADE,  -- NULL = platform default
  name          VARCHAR(100) NOT NULL,
  code          VARCHAR(50),
  parent_id     UUID REFERENCES expense_categories (id),
  category_type VARCHAR(20) NOT NULL DEFAULT 'operating', -- cogs | operating | non_operating | tax
  description   TEXT,
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Platform default expense categories
INSERT INTO expense_categories (id, name, code, category_type) VALUES
  (uuid_generate_v4(), 'Cost of Goods Sold (HPP)', 'COGS', 'cogs'),
  (uuid_generate_v4(), 'Staff Costs',               'STAFF', 'operating'),
  (uuid_generate_v4(), 'Rent',                      'RENT', 'operating'),
  (uuid_generate_v4(), 'Utilities',                 'UTIL', 'operating'),
  (uuid_generate_v4(), 'Marketing',                 'MKT', 'operating'),
  (uuid_generate_v4(), 'Logistics',                 'LOG', 'operating'),
  (uuid_generate_v4(), 'Maintenance',               'MAINT', 'operating'),
  (uuid_generate_v4(), 'Other Operating Expenses',  'OTHER_OP', 'operating'),
  (uuid_generate_v4(), 'Interest Expense',          'INTEREST', 'non_operating'),
  (uuid_generate_v4(), 'Tax',                       'TAX', 'tax');

CREATE INDEX idx_exp_categories_org ON expense_categories (org_id);

-- ── Products / SKUs ───────────────────────────────────────────────────────────
CREATE TABLE products (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id        UUID NOT NULL REFERENCES organisations (id) ON DELETE CASCADE,
  brand_id      UUID REFERENCES brands (id),
  sku           VARCHAR(100),
  name          VARCHAR(255) NOT NULL,
  description   TEXT,
  category      VARCHAR(100),
  unit          VARCHAR(50) NOT NULL DEFAULT 'pcs',
  unit_cost     NUMERIC(20, 2),
  unit_price    NUMERIC(20, 2),
  currency      VARCHAR(3) NOT NULL DEFAULT 'IDR',
  reorder_level INTEGER NOT NULL DEFAULT 0,
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at    TIMESTAMPTZ
);

CREATE INDEX idx_products_org   ON products (org_id) WHERE deleted_at IS NULL;
CREATE INDEX idx_products_brand ON products (brand_id) WHERE deleted_at IS NULL;

CREATE TRIGGER set_products_updated_at
  BEFORE UPDATE ON products
  FOR EACH ROW EXECUTE PROCEDURE trigger_set_updated_at();

-- ── Inventory balances ────────────────────────────────────────────────────────
CREATE TABLE inventory_balances (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  outlet_id     UUID NOT NULL REFERENCES outlets (id) ON DELETE CASCADE,
  product_id    UUID NOT NULL REFERENCES products (id) ON DELETE CASCADE,
  quantity      NUMERIC(20, 4) NOT NULL DEFAULT 0,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (outlet_id, product_id)
);

CREATE INDEX idx_inv_balance_outlet ON inventory_balances (outlet_id);

-- ── Inventory movements ───────────────────────────────────────────────────────
CREATE TABLE inventory_movements (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  outlet_id         UUID NOT NULL REFERENCES outlets (id) ON DELETE CASCADE,
  product_id        UUID NOT NULL REFERENCES products (id) ON DELETE CASCADE,
  movement_type     VARCHAR(30) NOT NULL,
  -- receive | issue | adjustment | transfer_in | transfer_out | sale | waste
  quantity          NUMERIC(20, 4) NOT NULL,
  unit_cost         NUMERIC(20, 2),
  total_cost        NUMERIC(20, 2),
  reference_id      UUID,           -- sale_id, transfer_id etc.
  reference_type    VARCHAR(50),
  notes             TEXT,
  moved_by          UUID REFERENCES users (id),
  movement_date     DATE NOT NULL DEFAULT CURRENT_DATE,
  import_batch_id   UUID,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_inv_movement_outlet  ON inventory_movements (outlet_id, movement_date DESC);
CREATE INDEX idx_inv_movement_product ON inventory_movements (product_id);

-- ── Sales records ─────────────────────────────────────────────────────────────
CREATE TABLE sales_records (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  outlet_id         UUID NOT NULL REFERENCES outlets (id) ON DELETE CASCADE,
  sale_date         DATE NOT NULL,
  gross_sales       NUMERIC(20, 2) NOT NULL DEFAULT 0,
  discounts         NUMERIC(20, 2) NOT NULL DEFAULT 0,
  returns           NUMERIC(20, 2) NOT NULL DEFAULT 0,
  net_sales         NUMERIC(20, 2) GENERATED ALWAYS AS (gross_sales - discounts - returns) STORED,
  transaction_count INTEGER NOT NULL DEFAULT 0,
  currency          VARCHAR(3) NOT NULL DEFAULT 'IDR',
  notes             TEXT,
  source            VARCHAR(50) NOT NULL DEFAULT 'manual', -- manual | import | pos_sync
  import_batch_id   UUID,
  created_by        UUID REFERENCES users (id),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at        TIMESTAMPTZ
);

CREATE INDEX idx_sales_outlet_date ON sales_records (outlet_id, sale_date DESC) WHERE deleted_at IS NULL;
CREATE INDEX idx_sales_date        ON sales_records (sale_date DESC) WHERE deleted_at IS NULL;

CREATE TRIGGER set_sales_updated_at
  BEFORE UPDATE ON sales_records
  FOR EACH ROW EXECUTE PROCEDURE trigger_set_updated_at();

-- ── Operating expenses ────────────────────────────────────────────────────────
CREATE TABLE operating_expenses (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  outlet_id           UUID NOT NULL REFERENCES outlets (id) ON DELETE CASCADE,
  expense_category_id UUID NOT NULL REFERENCES expense_categories (id),
  expense_date        DATE NOT NULL,
  amount              NUMERIC(20, 2) NOT NULL,
  currency            VARCHAR(3) NOT NULL DEFAULT 'IDR',
  description         TEXT,
  reference           VARCHAR(255),
  source              VARCHAR(50) NOT NULL DEFAULT 'manual',
  import_batch_id     UUID,
  created_by          UUID REFERENCES users (id),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at          TIMESTAMPTZ
);

CREATE INDEX idx_expenses_outlet_date ON operating_expenses (outlet_id, expense_date DESC) WHERE deleted_at IS NULL;

CREATE TRIGGER set_expenses_updated_at
  BEFORE UPDATE ON operating_expenses
  FOR EACH ROW EXECUTE PROCEDURE trigger_set_updated_at();

-- ── Targets ───────────────────────────────────────────────────────────────────
CREATE TABLE targets (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id            UUID NOT NULL REFERENCES organisations (id) ON DELETE CASCADE,
  brand_id          UUID REFERENCES brands (id),
  region_id         UUID REFERENCES regions (id),
  outlet_id         UUID REFERENCES outlets (id),
  target_type       VARCHAR(30) NOT NULL DEFAULT 'sales', -- sales | profit | transactions
  period_type       VARCHAR(10) NOT NULL DEFAULT 'monthly', -- daily | weekly | monthly | yearly
  period_year       INTEGER NOT NULL,
  period_value      INTEGER,           -- month (1-12), week number, or NULL for yearly
  target_amount     NUMERIC(20, 2) NOT NULL,
  currency          VARCHAR(3) NOT NULL DEFAULT 'IDR',
  created_by        UUID REFERENCES users (id),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_targets_outlet ON targets (outlet_id, period_year, period_value);
CREATE INDEX idx_targets_org    ON targets (org_id, period_year);

CREATE TRIGGER set_targets_updated_at
  BEFORE UPDATE ON targets
  FOR EACH ROW EXECUTE PROCEDURE trigger_set_updated_at();
