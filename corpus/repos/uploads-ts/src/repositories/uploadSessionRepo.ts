import type { Queryable } from "../db/pool.js";
import type { UploadSession, UploadSessionState } from "../domain/uploadSession.js";
import { firstRow, requireRow, toSafeInteger } from "./mapping.js";

interface UploadSessionRow {
  id: string;
  tenant_id: string;
  path: string;
  size: string;
  declared_type: string | null;
  original_name: string;
  overwrite: boolean;
  offset_bytes: string;
  part_count: number;
  state: UploadSessionState;
  chunk_token: string | null;
  chunk_lease_expires_at: Date | null;
  file_id: string | null;
  created_at: Date;
  updated_at: Date;
  expires_at: Date;
}

const COLUMNS = `id, tenant_id, path, size, declared_type, original_name, overwrite, offset_bytes,
  part_count, state, chunk_token, chunk_lease_expires_at, file_id, created_at, updated_at,
  expires_at`;

function mapSession(row: UploadSessionRow): UploadSession {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    path: row.path,
    size: toSafeInteger(row.size, "upload_sessions.size"),
    declaredType: row.declared_type,
    originalName: row.original_name,
    overwrite: row.overwrite,
    offset: toSafeInteger(row.offset_bytes, "upload_sessions.offset_bytes"),
    partCount: row.part_count,
    state: row.state,
    chunkToken: row.chunk_token,
    chunkLeaseExpiresAt: row.chunk_lease_expires_at,
    fileId: row.file_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    expiresAt: row.expires_at,
  };
}

export interface NewUploadSession {
  readonly id: string;
  readonly tenantId: string;
  readonly path: string;
  readonly size: number;
  readonly declaredType: string | null;
  readonly originalName: string;
  readonly overwrite: boolean;
  readonly createdAt: Date;
  readonly expiresAt: Date;
}

export async function insertSession(db: Queryable, session: NewUploadSession): Promise<UploadSession> {
  const result = await db.query<UploadSessionRow>(
    `INSERT INTO upload_sessions (id, tenant_id, path, size, declared_type, original_name,
       overwrite, state, created_at, updated_at, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'open', $8, $8, $9)
     RETURNING ${COLUMNS}`,
    [
      session.id,
      session.tenantId,
      session.path,
      session.size,
      session.declaredType,
      session.originalName,
      session.overwrite,
      session.createdAt,
      session.expiresAt,
    ],
  );
  return mapSession(requireRow(result.rows, "insertSession"));
}

export async function findSession(
  db: Queryable,
  tenantId: string,
  id: string,
  options: { forUpdate?: boolean } = {},
): Promise<UploadSession | null> {
  const result = await db.query<UploadSessionRow>(
    `SELECT ${COLUMNS} FROM upload_sessions WHERE tenant_id = $1 AND id = $2
     ${options.forUpdate ? "FOR UPDATE" : ""}`,
    [tenantId, id],
  );
  const row = firstRow(result.rows);
  return row ? mapSession(row) : null;
}

/**
 * Claim the right to write the next chunk: only an open, unexpired session at exactly `offset`
 * whose previous writer is done (or whose claim has lapsed). Null when any condition fails; the
 * caller reads the session to tell the client which.
 */
export async function claimChunk(
  db: Queryable,
  claim: {
    tenantId: string;
    id: string;
    offset: number;
    token: string;
    now: Date;
    leaseExpiresAt: Date;
  },
): Promise<UploadSession | null> {
  const result = await db.query<UploadSessionRow>(
    `UPDATE upload_sessions
     SET chunk_token = $4, chunk_lease_expires_at = $6, updated_at = $5
     WHERE tenant_id = $1 AND id = $2 AND state = 'open' AND expires_at > $5
       AND offset_bytes = $3
       AND (chunk_token IS NULL OR chunk_lease_expires_at <= $5)
     RETURNING ${COLUMNS}`,
    [claim.tenantId, claim.id, claim.offset, claim.token, claim.now, claim.leaseExpiresAt],
  );
  const row = firstRow(result.rows);
  return row ? mapSession(row) : null;
}

/**
 * Append a staged chunk of `bytes` as the next part and give up the claim. Only the holder of
 * `token` can commit, and only while the session is still open.
 */
export async function commitChunk(
  db: Queryable,
  commit: { id: string; token: string; bytes: number; now: Date },
): Promise<UploadSession | null> {
  const result = await db.query<UploadSessionRow>(
    `UPDATE upload_sessions
     SET offset_bytes = offset_bytes + $3, part_count = part_count + 1,
       chunk_token = NULL, chunk_lease_expires_at = NULL, updated_at = $4
     WHERE id = $1 AND chunk_token = $2 AND state = 'open' AND offset_bytes + $3 <= size
     RETURNING ${COLUMNS}`,
    [commit.id, commit.token, commit.bytes, commit.now],
  );
  const row = firstRow(result.rows);
  return row ? mapSession(row) : null;
}

/** Give up a chunk claim without appending (the chunk failed). */
export async function releaseChunk(db: Queryable, id: string, token: string): Promise<void> {
  await db.query(
    `UPDATE upload_sessions SET chunk_token = NULL, chunk_lease_expires_at = NULL
     WHERE id = $1 AND chunk_token = $2`,
    [id, token],
  );
}

/**
 * Close an open session: `completed` (with its file), `aborted` or `expired`. Conditional on the
 * session still being open, so only one of competing closers wins.
 */
export async function closeSession(
  db: Queryable,
  close: { id: string; state: Exclude<UploadSessionState, "open">; fileId?: string; now: Date },
): Promise<UploadSession | null> {
  const result = await db.query<UploadSessionRow>(
    `UPDATE upload_sessions
     SET state = $2, file_id = $3, updated_at = $4, chunk_token = NULL, chunk_lease_expires_at = NULL
     WHERE id = $1 AND state = 'open'
     RETURNING ${COLUMNS}`,
    [close.id, close.state, close.fileId ?? null, close.now],
  );
  const row = firstRow(result.rows);
  return row ? mapSession(row) : null;
}

/** Open sessions past their expiry, locked for the caller's transaction; locked rows are skipped. */
export async function lockExpiredSessions(
  db: Queryable,
  now: Date,
  limit: number,
): Promise<UploadSession[]> {
  const result = await db.query<UploadSessionRow>(
    `SELECT ${COLUMNS} FROM upload_sessions
     WHERE state = 'open' AND expires_at <= $1
     ORDER BY expires_at, id
     LIMIT $2
     FOR UPDATE SKIP LOCKED`,
    [now, limit],
  );
  return result.rows.map(mapSession);
}

/** Which of `ids` are open sessions (whose staged parts must be kept). */
export async function findOpenSessionIds(db: Queryable, ids: string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const result = await db.query<{ id: string }>(
    `SELECT id FROM upload_sessions WHERE id = ANY($1::uuid[]) AND state = 'open'`,
    [ids],
  );
  return new Set(result.rows.map((row) => row.id));
}
