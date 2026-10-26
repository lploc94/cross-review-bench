-- Stored files. `path` is the tenant's folder-like name; the storage key is derived from the file id
-- and never from the path. Paths compare byte-wise (COLLATE "C") so listings order the same way on
-- every database regardless of its locale.
CREATE TABLE files (
  id                uuid PRIMARY KEY,
  tenant_id         uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  path              text COLLATE "C" NOT NULL,
  size              bigint NOT NULL CHECK (size >= 0),
  sha256            text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  content_type      text NOT NULL,
  declared_type     text,
  original_name     text NOT NULL,
  storage_driver    text NOT NULL CHECK (storage_driver IN ('local', 's3')),
  storage_key       text NOT NULL,
  status            text NOT NULL
                    CHECK (status IN ('pending_scan', 'available', 'quarantined', 'deleted')),
  image_width       integer CHECK (image_width > 0),
  image_height      integer CHECK (image_height > 0),
  scan_attempts     integer NOT NULL DEFAULT 0 CHECK (scan_attempts >= 0),
  next_scan_at      timestamptz,
  scanned_at        timestamptz,
  created_at        timestamptz NOT NULL,
  updated_at        timestamptz NOT NULL,
  deleted_at        timestamptz,
  -- Set once the storage object of a deleted file is gone (right after the delete, or by cleanup).
  object_deleted_at timestamptz,
  CHECK ((status = 'deleted') = (deleted_at IS NOT NULL)),
  CHECK ((image_width IS NULL) = (image_height IS NULL)),
  CHECK (object_deleted_at IS NULL OR status = 'deleted')
);

-- One live file per path (deleted rows keep their path for reference); also serves the listing,
-- which pages through a tenant's live files in path order.
CREATE UNIQUE INDEX files_tenant_path_live ON files (tenant_id, path) WHERE status <> 'deleted';

CREATE INDEX files_scan_queue ON files (next_scan_at) WHERE status = 'pending_scan';

CREATE INDEX files_deleted_objects ON files (deleted_at)
  WHERE status = 'deleted' AND object_deleted_at IS NULL;

CREATE UNIQUE INDEX files_storage_key ON files (storage_key);
