-- Tenants own every other row. used_bytes is the sum of the sizes of the tenant's live files plus
-- the bytes reserved by uploads in progress; it only changes through reserve/release statements.
CREATE TABLE tenants (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  quota_bytes bigint NOT NULL CHECK (quota_bytes >= 0),
  used_bytes  bigint NOT NULL DEFAULT 0 CHECK (used_bytes >= 0),
  created_at  timestamptz NOT NULL
);

-- API keys: `up_<prefix>_<secret>`; only the sha256 of the secret is stored.
CREATE TABLE api_keys (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  name        text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  prefix      text NOT NULL UNIQUE CHECK (prefix ~ '^[a-z0-9]{8}$'),
  secret_hash text NOT NULL CHECK (secret_hash ~ '^[0-9a-f]{64}$'),
  scopes      text[] NOT NULL,
  created_at  timestamptz NOT NULL,
  revoked_at  timestamptz
);

CREATE INDEX api_keys_tenant ON api_keys (tenant_id);
