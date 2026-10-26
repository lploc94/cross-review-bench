import type { Queryable } from "../db/pool.js";
import type { FileCursor } from "../domain/cursor.js";
import type { FileRecord, FileStatus } from "../domain/file.js";
import { firstRow, requireRow, toSafeInteger } from "./mapping.js";

interface FileRow {
  id: string;
  tenant_id: string;
  path: string;
  size: string;
  sha256: string;
  content_type: string;
  declared_type: string | null;
  original_name: string;
  storage_driver: string;
  storage_key: string;
  status: FileStatus;
  image_width: number | null;
  image_height: number | null;
  scan_attempts: number;
  next_scan_at: Date | null;
  scanned_at: Date | null;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
  object_deleted_at: Date | null;
}

const COLUMNS = `id, tenant_id, path, size, sha256, content_type, declared_type, original_name,
  storage_driver, storage_key, status, image_width, image_height, scan_attempts, next_scan_at,
  scanned_at, created_at, updated_at, deleted_at, object_deleted_at`;

/** The same columns qualified with the `files` table, for statements that join. */
const QUALIFIED_COLUMNS = COLUMNS.split(",")
  .map((column) => `files.${column.trim()}`)
  .join(", ");

function mapFile(row: FileRow): FileRecord {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    path: row.path,
    size: toSafeInteger(row.size, "files.size"),
    sha256: row.sha256,
    contentType: row.content_type,
    declaredType: row.declared_type,
    originalName: row.original_name,
    storageDriver: row.storage_driver,
    storageKey: row.storage_key,
    status: row.status,
    image:
      row.image_width !== null && row.image_height !== null
        ? { width: row.image_width, height: row.image_height }
        : null,
    scanAttempts: row.scan_attempts,
    nextScanAt: row.next_scan_at,
    scannedAt: row.scanned_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
    objectDeletedAt: row.object_deleted_at,
  };
}

export interface NewFile {
  readonly id: string;
  readonly tenantId: string;
  readonly path: string;
  readonly size: number;
  readonly sha256: string;
  readonly contentType: string;
  readonly declaredType: string | null;
  readonly originalName: string;
  readonly storageDriver: string;
  readonly storageKey: string;
  readonly image: { width: number; height: number } | null;
  readonly createdAt: Date;
}

/** Insert a new file waiting for its scan; the scan is due at once. */
export async function insertFile(db: Queryable, file: NewFile): Promise<FileRecord> {
  const result = await db.query<FileRow>(
    `INSERT INTO files (id, tenant_id, path, size, sha256, content_type, declared_type,
       original_name, storage_driver, storage_key, status, image_width, image_height,
       next_scan_at, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'pending_scan', $11, $12, $13, $13, $13)
     RETURNING ${COLUMNS}`,
    [
      file.id,
      file.tenantId,
      file.path,
      file.size,
      file.sha256,
      file.contentType,
      file.declaredType,
      file.originalName,
      file.storageDriver,
      file.storageKey,
      file.image?.width ?? null,
      file.image?.height ?? null,
      file.createdAt,
    ],
  );
  return mapFile(requireRow(result.rows, "insertFile"));
}

/** The tenant's live (not deleted) file at `path`; `forUpdate` locks it for the transaction. */
export async function findLiveFileByPath(
  db: Queryable,
  tenantId: string,
  path: string,
  options: { forUpdate?: boolean } = {},
): Promise<FileRecord | null> {
  const result = await db.query<FileRow>(
    `SELECT ${COLUMNS} FROM files
     WHERE tenant_id = $1 AND path = $2 AND status <> 'deleted'
     ${options.forUpdate ? "FOR UPDATE" : ""}`,
    [tenantId, path],
  );
  const row = firstRow(result.rows);
  return row ? mapFile(row) : null;
}

/** The tenant's live file with this id; another tenant's file is not found. */
export async function findLiveFileById(
  db: Queryable,
  tenantId: string,
  id: string,
): Promise<FileRecord | null> {
  const result = await db.query<FileRow>(
    `SELECT ${COLUMNS} FROM files WHERE tenant_id = $1 AND id = $2 AND status <> 'deleted'`,
    [tenantId, id],
  );
  const row = firstRow(result.rows);
  return row ? mapFile(row) : null;
}

/**
 * A live file by id alone. Only for requests whose authority is a signed URL for this id;
 * everything else goes through a tenant-scoped lookup.
 */
export async function findLiveFileBySignedId(
  db: Queryable,
  id: string,
): Promise<FileRecord | null> {
  const result = await db.query<FileRow>(
    `SELECT ${COLUMNS} FROM files WHERE id = $1 AND status <> 'deleted'`,
    [id],
  );
  const row = firstRow(result.rows);
  return row ? mapFile(row) : null;
}

/** Up to `limit` live files after `after` in (path, id) order. */
export async function listLiveFiles(
  db: Queryable,
  tenantId: string,
  after: FileCursor | null,
  limit: number,
): Promise<FileRecord[]> {
  const result = after
    ? await db.query<FileRow>(
        `SELECT ${COLUMNS} FROM files
         WHERE tenant_id = $1 AND status <> 'deleted' AND (path, id) > ($2, $3)
         ORDER BY path, id
         LIMIT $4`,
        [tenantId, after.path, after.id, limit],
      )
    : await db.query<FileRow>(
        `SELECT ${COLUMNS} FROM files
         WHERE tenant_id = $1 AND status <> 'deleted'
         ORDER BY path, id
         LIMIT $2`,
        [tenantId, limit],
      );
  return result.rows.map(mapFile);
}

/** Soft-delete a live file. Returns the deleted row, or null when it was not live. */
export async function markDeleted(
  db: Queryable,
  tenantId: string,
  id: string,
  now: Date,
): Promise<FileRecord | null> {
  const result = await db.query<FileRow>(
    `UPDATE files SET status = 'deleted', deleted_at = $3, updated_at = $3, next_scan_at = NULL
     WHERE tenant_id = $1 AND id = $2 AND status <> 'deleted'
     RETURNING ${COLUMNS}`,
    [tenantId, id, now],
  );
  const row = firstRow(result.rows);
  return row ? mapFile(row) : null;
}

/** Record that the storage object of a deleted file is gone. */
export async function markObjectsDeleted(db: Queryable, ids: string[], now: Date): Promise<void> {
  if (ids.length === 0) return;
  await db.query(
    `UPDATE files SET object_deleted_at = $2
     WHERE id = ANY($1::uuid[]) AND status = 'deleted' AND object_deleted_at IS NULL`,
    [ids, now],
  );
}

/**
 * Deleted files whose storage object may still exist and whose grace period is over, locked for
 * the caller's transaction. Rows another cleanup run holds are skipped.
 */
export async function lockDeletedFilesWithObjects(
  db: Queryable,
  deletedBefore: Date,
  limit: number,
): Promise<FileRecord[]> {
  const result = await db.query<FileRow>(
    `SELECT ${COLUMNS} FROM files
     WHERE status = 'deleted' AND object_deleted_at IS NULL AND deleted_at <= $1
     ORDER BY deleted_at, id
     LIMIT $2
     FOR UPDATE SKIP LOCKED`,
    [deletedBefore, limit],
  );
  return result.rows.map(mapFile);
}

/**
 * Claim up to `limit` files whose scan is due, longest overdue first, and return them in that
 * order: their next scan is pushed to `claimedUntil`, so other workers leave them alone while this
 * one scans, and a worker that dies mid-scan only delays them. Rows locked by another worker's
 * claim are skipped.
 */
export async function claimFilesForScan(
  db: Queryable,
  now: Date,
  claimedUntil: Date,
  limit: number,
): Promise<FileRecord[]> {
  // RETURNING has no defined order, so the claimed rows are sorted again by the time they were due.
  const result = await db.query<FileRow>(
    `WITH due AS (
       SELECT id, next_scan_at AS due_at FROM files
       WHERE status = 'pending_scan' AND next_scan_at <= $1
       ORDER BY next_scan_at, id
       LIMIT $3
       FOR UPDATE SKIP LOCKED
     ), claimed AS (
       UPDATE files SET next_scan_at = $2
       FROM due
       WHERE files.id = due.id
       RETURNING ${QUALIFIED_COLUMNS}, due.due_at
     )
     SELECT ${COLUMNS} FROM claimed
     ORDER BY due_at, id`,
    [now, claimedUntil, limit],
  );
  return result.rows.map(mapFile);
}

/**
 * Record a scan verdict on a file that is still pending. Returns false when the file left the
 * pending state meanwhile (deleted or replaced), in which case nothing changes.
 */
export async function recordScanVerdict(
  db: Queryable,
  id: string,
  status: "available" | "quarantined",
  now: Date,
): Promise<boolean> {
  const result = await db.query(
    `UPDATE files SET status = $2, scanned_at = $3, updated_at = $3, next_scan_at = NULL
     WHERE id = $1 AND status = 'pending_scan'`,
    [id, status, now],
  );
  return result.rowCount === 1;
}

/** Count a failed scan attempt and schedule the next one. */
export async function recordScanFailure(
  db: Queryable,
  id: string,
  nextScanAt: Date,
  now: Date,
): Promise<boolean> {
  const result = await db.query(
    `UPDATE files SET scan_attempts = scan_attempts + 1, next_scan_at = $2, updated_at = $3
     WHERE id = $1 AND status = 'pending_scan'`,
    [id, nextScanAt, now],
  );
  return result.rowCount === 1;
}

/** Count the last failed scan attempt and quarantine the file: it can no longer be vouched for. */
export async function quarantineAfterFailures(db: Queryable, id: string, now: Date): Promise<boolean> {
  const result = await db.query(
    `UPDATE files SET scan_attempts = scan_attempts + 1, status = 'quarantined',
       next_scan_at = NULL, scanned_at = $2, updated_at = $2
     WHERE id = $1 AND status = 'pending_scan'`,
    [id, now],
  );
  return result.rowCount === 1;
}
