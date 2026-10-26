-- Every mutation the server has acknowledged, applied or not: pushing a mutation again is
-- recognised by (user_id, mutation_id) and acknowledged without being applied twice.
CREATE TABLE mutations (
  user_id     uuid NOT NULL REFERENCES users (id),
  mutation_id uuid NOT NULL,
  device_id   uuid NOT NULL REFERENCES devices (id),
  collection  text NOT NULL,
  doc_id      text NOT NULL,
  -- canonical HLC strings sort bytewise; "C" keeps that order in SQL
  hlc         text COLLATE "C" NOT NULL,
  received_at timestamptz NOT NULL,
  PRIMARY KEY (user_id, mutation_id)
);

-- The change feed: one row per field write that won last-writer-wins when it arrived. Clients
-- pull it in seq order.
CREATE TABLE events (
  seq                bigserial PRIMARY KEY,
  user_id            uuid NOT NULL REFERENCES users (id),
  device_id          uuid NOT NULL REFERENCES devices (id),
  mutation_id        uuid NOT NULL,
  collection         text NOT NULL,
  doc_id             text NOT NULL,
  field              text NOT NULL,
  value              jsonb NOT NULL,
  hlc                text COLLATE "C" NOT NULL,
  server_received_at timestamptz NOT NULL,
  UNIQUE (user_id, mutation_id, field),
  FOREIGN KEY (user_id, mutation_id) REFERENCES mutations (user_id, mutation_id)
);

CREATE INDEX events_user_seq_idx ON events (user_id, seq);
