-- Accounts. A user owns documents; each of the user's installations is a device with its own
-- bearer token, of which only the sha256 is stored.
CREATE TABLE users (
  id           uuid PRIMARY KEY,
  -- stored lowercased by the application
  email        text NOT NULL UNIQUE,
  display_name text NOT NULL,
  created_at   timestamptz NOT NULL
);

CREATE TABLE devices (
  id           uuid PRIMARY KEY,
  user_id      uuid NOT NULL REFERENCES users (id),
  -- hex sha256 of the token's secret part
  token_hash   text NOT NULL CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  name         text NOT NULL,
  created_at   timestamptz NOT NULL,
  last_seen_at timestamptz
);

CREATE INDEX devices_user_id_idx ON devices (user_id, created_at);
