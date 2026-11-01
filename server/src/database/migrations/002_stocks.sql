-- ============================================================================
-- Migration 002: Stock market management schema
-- ============================================================================

-- ── Exchanges ─────────────────────────────────────────────────────────────────
CREATE TABLE exchanges (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  code        VARCHAR(20) NOT NULL UNIQUE,  -- IDX, NYSE, NASDAQ, LSE
  name        VARCHAR(255) NOT NULL,
  country     VARCHAR(2) NOT NULL,
  currency    VARCHAR(3) NOT NULL,
  timezone    VARCHAR(50) NOT NULL DEFAULT 'UTC',
  is_active   BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO exchanges (code, name, country, currency, timezone) VALUES
  ('IDX',    'Indonesia Stock Exchange',   'ID', 'IDR', 'Asia/Jakarta'),
  ('NYSE',   'New York Stock Exchange',    'US', 'USD', 'America/New_York'),
  ('NASDAQ', 'NASDAQ Stock Market',        'US', 'USD', 'America/New_York'),
  ('LSE',    'London Stock Exchange',      'GB', 'GBP', 'Europe/London'),
  ('SGX',    'Singapore Exchange',         'SG', 'SGD', 'Asia/Singapore'),
  ('HKEX',   'Hong Kong Exchanges',        'HK', 'HKD', 'Asia/Hong_Kong'),
  ('TSE',    'Tokyo Stock Exchange',       'JP', 'JPY', 'Asia/Tokyo'),
  ('DEMO',   'Demo Exchange (Not Real)',   'XX', 'USD', 'UTC');

-- ── Instruments ───────────────────────────────────────────────────────────────
CREATE TABLE instruments (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  exchange_id         UUID NOT NULL REFERENCES exchanges (id),
  symbol              VARCHAR(20) NOT NULL,
  name                VARCHAR(255) NOT NULL,
  isin                VARCHAR(12),
  asset_type          VARCHAR(50) NOT NULL DEFAULT 'stock', -- stock | etf | reksadana | bond | crypto
  currency            VARCHAR(3) NOT NULL,
  sector              VARCHAR(100),
  industry            VARCHAR(100),
  description         TEXT,
  provider_symbol     VARCHAR(50),    -- symbol used by market-data provider
  is_active           BOOLEAN NOT NULL DEFAULT TRUE,
  is_demo             BOOLEAN NOT NULL DEFAULT FALSE,
  last_price          NUMERIC(20, 6),
  last_price_at       TIMESTAMPTZ,
  price_source        VARCHAR(50),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (exchange_id, symbol)
);

CREATE INDEX idx_instruments_symbol   ON instruments (symbol);
CREATE INDEX idx_instruments_exchange ON instruments (exchange_id);

CREATE TRIGGER set_instruments_updated_at
  BEFORE UPDATE ON instruments
  FOR EACH ROW EXECUTE PROCEDURE trigger_set_updated_at();

-- ── Market price observations ─────────────────────────────────────────────────
CREATE TABLE price_observations (
  id              BIGSERIAL PRIMARY KEY,
  instrument_id   UUID NOT NULL REFERENCES instruments (id) ON DELETE CASCADE,
  price_date      DATE NOT NULL,
  open_price      NUMERIC(20, 6),
  high_price      NUMERIC(20, 6),
  low_price       NUMERIC(20, 6),
  close_price     NUMERIC(20, 6) NOT NULL,
  adj_close       NUMERIC(20, 6),
  volume          BIGINT,
  is_demo         BOOLEAN NOT NULL DEFAULT FALSE,
  source          VARCHAR(50),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (instrument_id, price_date)
);

CREATE INDEX idx_prices_instrument_date ON price_observations (instrument_id, price_date DESC);

-- ── Exchange rates ────────────────────────────────────────────────────────────
CREATE TABLE exchange_rates (
  id              BIGSERIAL PRIMARY KEY,
  from_currency   VARCHAR(3) NOT NULL,
  to_currency     VARCHAR(3) NOT NULL,
  rate            NUMERIC(20, 8) NOT NULL,
  rate_date       DATE NOT NULL,
  source          VARCHAR(50),
  is_demo         BOOLEAN NOT NULL DEFAULT FALSE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (from_currency, to_currency, rate_date)
);

CREATE INDEX idx_rates_pair_date ON exchange_rates (from_currency, to_currency, rate_date DESC);

-- ── Portfolios ────────────────────────────────────────────────────────────────
CREATE TABLE portfolios (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id           UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  org_id            UUID REFERENCES organisations (id) ON DELETE CASCADE,
  name              VARCHAR(255) NOT NULL,
  description       TEXT,
  base_currency     VARCHAR(3) NOT NULL DEFAULT 'IDR',
  cost_basis_method VARCHAR(10) NOT NULL DEFAULT 'WAC', -- WAC | FIFO
  is_default        BOOLEAN NOT NULL DEFAULT FALSE,
  is_active         BOOLEAN NOT NULL DEFAULT TRUE,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at        TIMESTAMPTZ
);

CREATE INDEX idx_portfolios_user  ON portfolios (user_id) WHERE deleted_at IS NULL;
CREATE INDEX idx_portfolios_org   ON portfolios (org_id) WHERE deleted_at IS NULL;

CREATE TRIGGER set_portfolios_updated_at
  BEFORE UPDATE ON portfolios
  FOR EACH ROW EXECUTE PROCEDURE trigger_set_updated_at();

-- ── Portfolio transactions ────────────────────────────────────────────────────
CREATE TABLE portfolio_transactions (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  portfolio_id        UUID NOT NULL REFERENCES portfolios (id) ON DELETE CASCADE,
  instrument_id       UUID REFERENCES instruments (id),
  transaction_type    VARCHAR(20) NOT NULL,
  -- buy | sell | dividend | deposit | withdrawal | fee | split | bonus
  transaction_date    DATE NOT NULL,
  transaction_time    TIME,
  quantity            NUMERIC(20, 8),
  price               NUMERIC(20, 6),
  total_amount        NUMERIC(20, 2) NOT NULL,
  fee                 NUMERIC(20, 2) NOT NULL DEFAULT 0,
  currency            VARCHAR(3) NOT NULL,
  exchange_rate       NUMERIC(20, 8),          -- rate to portfolio base currency
  base_amount         NUMERIC(20, 2),           -- amount in portfolio base currency
  notes               TEXT,
  reference           VARCHAR(255),
  is_demo             BOOLEAN NOT NULL DEFAULT FALSE,
  broker_id           UUID,
  import_batch_id     UUID,
  reversal_of         UUID REFERENCES portfolio_transactions (id),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at          TIMESTAMPTZ
);

CREATE INDEX idx_ptxn_portfolio      ON portfolio_transactions (portfolio_id, transaction_date DESC) WHERE deleted_at IS NULL;
CREATE INDEX idx_ptxn_instrument     ON portfolio_transactions (instrument_id) WHERE deleted_at IS NULL;
CREATE INDEX idx_ptxn_type           ON portfolio_transactions (transaction_type);

CREATE TRIGGER set_ptxn_updated_at
  BEFORE UPDATE ON portfolio_transactions
  FOR EACH ROW EXECUTE PROCEDURE trigger_set_updated_at();

-- ── Watchlists ────────────────────────────────────────────────────────────────
CREATE TABLE watchlists (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id     UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  org_id      UUID REFERENCES organisations (id) ON DELETE CASCADE,
  name        VARCHAR(255) NOT NULL,
  description TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at  TIMESTAMPTZ
);

CREATE TRIGGER set_watchlists_updated_at
  BEFORE UPDATE ON watchlists
  FOR EACH ROW EXECUTE PROCEDURE trigger_set_updated_at();

CREATE TABLE watchlist_items (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  watchlist_id    UUID NOT NULL REFERENCES watchlists (id) ON DELETE CASCADE,
  instrument_id   UUID NOT NULL REFERENCES instruments (id) ON DELETE CASCADE,
  added_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  notes           TEXT,
  UNIQUE (watchlist_id, instrument_id)
);

-- ── Corporate actions ─────────────────────────────────────────────────────────
CREATE TABLE corporate_actions (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  instrument_id   UUID NOT NULL REFERENCES instruments (id) ON DELETE CASCADE,
  action_type     VARCHAR(50) NOT NULL,  -- split | bonus | rights | delisting
  action_date     DATE NOT NULL,
  ratio           NUMERIC(10, 6),        -- e.g. 2.0 for 2:1 split
  details         JSONB,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_corp_actions_instrument ON corporate_actions (instrument_id, action_date DESC);

-- ── Broker integrations ───────────────────────────────────────────────────────
CREATE TABLE broker_connections (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id         UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  org_id          UUID REFERENCES organisations (id),
  provider        VARCHAR(50) NOT NULL,
  display_name    VARCHAR(255),
  status          VARCHAR(20) NOT NULL DEFAULT 'disconnected',
  config          JSONB,                -- non-secret config only
  last_synced_at  TIMESTAMPTZ,
  error_message   TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TRIGGER set_broker_conn_updated_at
  BEFORE UPDATE ON broker_connections
  FOR EACH ROW EXECUTE PROCEDURE trigger_set_updated_at();
