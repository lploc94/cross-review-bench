-- The last seq each device has confirmed: the `after` of its latest pull.
CREATE TABLE device_cursors (
  device_id       uuid PRIMARY KEY REFERENCES devices (id),
  last_pulled_seq bigint NOT NULL CHECK (last_pulled_seq >= 0),
  updated_at      timestamptz NOT NULL
);
