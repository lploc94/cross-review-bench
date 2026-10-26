-- Resumable uploads. The declared size is reserved against the tenant's quota when the session is
-- created and released when it is aborted or expires; on completion it becomes the file's bytes.
CREATE TABLE upload_sessions (
  id                     uuid PRIMARY KEY,
  tenant_id              uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  path                   text COLLATE "C" NOT NULL,
  size                   bigint NOT NULL CHECK (size > 0),
  declared_type          text,
  original_name          text NOT NULL,
  overwrite              boolean NOT NULL DEFAULT false,
  offset_bytes           bigint NOT NULL DEFAULT 0 CHECK (offset_bytes >= 0 AND offset_bytes <= size),
  part_count             integer NOT NULL DEFAULT 0 CHECK (part_count >= 0),
  state                  text NOT NULL CHECK (state IN ('open', 'completed', 'aborted', 'expired')),
  -- The writer of the chunk in progress, if any, and when its claim lapses.
  chunk_token            uuid,
  chunk_lease_expires_at timestamptz,
  file_id                uuid REFERENCES files (id),
  created_at             timestamptz NOT NULL,
  updated_at             timestamptz NOT NULL,
  expires_at             timestamptz NOT NULL,
  CHECK ((chunk_token IS NULL) = (chunk_lease_expires_at IS NULL)),
  CHECK ((state = 'completed') = (file_id IS NOT NULL))
);

CREATE INDEX upload_sessions_tenant ON upload_sessions (tenant_id, created_at);
CREATE INDEX upload_sessions_expiry ON upload_sessions (expires_at) WHERE state = 'open';
