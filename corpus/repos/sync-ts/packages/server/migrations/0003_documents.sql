-- Materialised state of every document: its fields and, per field, the HLC of the write that set
-- it. updated_seq is the seq of the last event that changed the document.
CREATE TABLE documents (
  user_id     uuid NOT NULL REFERENCES users (id),
  collection  text NOT NULL,
  doc_id      text NOT NULL,
  fields      jsonb NOT NULL CHECK (jsonb_typeof(fields) = 'object'),
  field_hlcs  jsonb NOT NULL CHECK (jsonb_typeof(field_hlcs) = 'object'),
  updated_seq bigint NOT NULL,
  updated_at  timestamptz NOT NULL,
  PRIMARY KEY (user_id, collection, doc_id)
);
