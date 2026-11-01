-- ============================================================================
-- Migration 001: Identity, tenant management, and permissions
-- ============================================================================

-- Enable extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ── Users ─────────────────────────────────────────────────────────────────────
CREATE TABLE users (
  id                    UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  email                 VARCHAR(320) NOT NULL UNIQUE,
  email_verified        BOOLEAN NOT NULL DEFAULT FALSE,
  password_hash         TEXT NOT NULL,
  full_name             VARCHAR(255) NOT NULL,
  avatar_url            TEXT,
  locale                VARCHAR(10) NOT NULL DEFAULT 'id',
  timezone              VARCHAR(50) NOT NULL DEFAULT 'Asia/Jakarta',
  is_active             BOOLEAN NOT NULL DEFAULT TRUE,
  is_superadmin         BOOLEAN NOT NULL DEFAULT FALSE,
  two_factor_enabled    BOOLEAN NOT NULL DEFAULT FALSE,
  two_factor_secret     TEXT,
  last_login_at         TIMESTAMPTZ,
  login_attempts        INTEGER NOT NULL DEFAULT 0,
  locked_until          TIMESTAMPTZ,
  password_reset_token  TEXT,
  password_reset_expiry TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at            TIMESTAMPTZ
);

CREATE INDEX idx_users_email        ON users (email) WHERE deleted_at IS NULL;
CREATE INDEX idx_users_is_active    ON users (is_active) WHERE deleted_at IS NULL;

-- ── Organisations (tenants) ───────────────────────────────────────────────────
CREATE TABLE organisations (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name                VARCHAR(255) NOT NULL,
  slug                VARCHAR(100) NOT NULL UNIQUE,
  description         TEXT,
  logo_url            TEXT,
  country             VARCHAR(2) NOT NULL DEFAULT 'ID',
  default_currency    VARCHAR(3) NOT NULL DEFAULT 'IDR',
  default_timezone    VARCHAR(50) NOT NULL DEFAULT 'Asia/Jakarta',
  locale              VARCHAR(10) NOT NULL DEFAULT 'id',
  modules_enabled     JSONB NOT NULL DEFAULT '["stocks","franchise"]',
  is_active           BOOLEAN NOT NULL DEFAULT TRUE,
  owner_id            UUID NOT NULL REFERENCES users (id),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at          TIMESTAMPTZ
);

CREATE INDEX idx_orgs_slug         ON organisations (slug) WHERE deleted_at IS NULL;
CREATE INDEX idx_orgs_owner        ON organisations (owner_id);

-- ── Roles ─────────────────────────────────────────────────────────────────────
CREATE TABLE roles (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name        VARCHAR(50) NOT NULL UNIQUE,  -- superadmin, org_owner, manager, staff, personal
  description TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO roles (name, description) VALUES
  ('superadmin',  'Platform-wide administrator'),
  ('org_owner',   'Organisation owner — full access within their organisation'),
  ('manager',     'Manager — assigned-scope access'),
  ('staff',       'Staff — data entry and limited operational access'),
  ('personal',    'Personal user — portfolio management only');

-- ── Permissions ───────────────────────────────────────────────────────────────
CREATE TABLE permissions (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  module      VARCHAR(50) NOT NULL,  -- stocks | franchise | shared | admin
  resource    VARCHAR(100) NOT NULL,
  action      VARCHAR(50) NOT NULL,  -- create | read | update | delete | export | import | manage
  description TEXT,
  UNIQUE (module, resource, action)
);

-- ── Role permissions ──────────────────────────────────────────────────────────
CREATE TABLE role_permissions (
  role_id       UUID NOT NULL REFERENCES roles (id) ON DELETE CASCADE,
  permission_id UUID NOT NULL REFERENCES permissions (id) ON DELETE CASCADE,
  PRIMARY KEY (role_id, permission_id)
);

-- ── Organisation memberships ──────────────────────────────────────────────────
CREATE TABLE org_memberships (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id          UUID NOT NULL REFERENCES organisations (id) ON DELETE CASCADE,
  user_id         UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  role_id         UUID NOT NULL REFERENCES roles (id),
  invited_by      UUID REFERENCES users (id),
  is_active       BOOLEAN NOT NULL DEFAULT TRUE,
  joined_at       TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (org_id, user_id)
);

CREATE INDEX idx_memberships_org    ON org_memberships (org_id) WHERE is_active = TRUE;
CREATE INDEX idx_memberships_user   ON org_memberships (user_id) WHERE is_active = TRUE;

-- ── Sessions ──────────────────────────────────────────────────────────────────
CREATE TABLE sessions (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id       UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  token_hash    TEXT NOT NULL UNIQUE,
  ip_address    INET,
  user_agent    TEXT,
  expires_at    TIMESTAMPTZ NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_used_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_sessions_user    ON sessions (user_id);
CREATE INDEX idx_sessions_expiry  ON sessions (expires_at);

-- ── Audit events ──────────────────────────────────────────────────────────────
CREATE TABLE audit_events (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id          UUID REFERENCES organisations (id),
  actor_id        UUID REFERENCES users (id),
  actor_email     VARCHAR(320),
  action          VARCHAR(100) NOT NULL,
  resource_type   VARCHAR(100) NOT NULL,
  resource_id     TEXT,
  old_values      JSONB,
  new_values      JSONB,
  metadata        JSONB,
  ip_address      INET,
  user_agent      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_audit_org        ON audit_events (org_id, created_at DESC);
CREATE INDEX idx_audit_actor      ON audit_events (actor_id, created_at DESC);
CREATE INDEX idx_audit_resource   ON audit_events (resource_type, resource_id);
CREATE INDEX idx_audit_created    ON audit_events (created_at DESC);

-- ── updated_at trigger ────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION trigger_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER set_users_updated_at
  BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE PROCEDURE trigger_set_updated_at();

CREATE TRIGGER set_orgs_updated_at
  BEFORE UPDATE ON organisations
  FOR EACH ROW EXECUTE PROCEDURE trigger_set_updated_at();

CREATE TRIGGER set_memberships_updated_at
  BEFORE UPDATE ON org_memberships
  FOR EACH ROW EXECUTE PROCEDURE trigger_set_updated_at();
