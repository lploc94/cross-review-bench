import { createHash } from "node:crypto";
import type { Queryable } from "../db/pool.js";
import { ConflictError, IdempotencyConflictError } from "../domain/errors.js";
import { canonicalJson, type JsonValue } from "../domain/json.js";
import * as idempotencyKeys from "../repositories/idempotencyKeys.js";

/**
 * Idempotency keys make a retried request safe: the first request with a key runs and its
 * response is stored with the key; a later request with the same key and the same content gets
 * the stored response again instead of running twice, and one with different content is refused.
 *
 * The key is claimed inside the caller's transaction, so it is only kept when the operation
 * commits: a request that fails leaves no trace and can be retried with the same key. Keys are
 * always scoped by tenant.
 */
export interface IdempotencyScope {
  readonly tenantId: string;
  readonly key: string;
  readonly requestHash: string;
}

export interface StoredResponse {
  readonly status: number;
  readonly body: JsonValue;
}

export interface IdempotentResult {
  readonly response: StoredResponse;
  readonly replayed: boolean;
}

/** Fingerprint of a request: the operation and its normalized body, key order ignored. */
export function hashRequest(operation: string, body: JsonValue): string {
  return createHash("sha256")
    .update(canonicalJson({ operation, body }))
    .digest("hex");
}

/**
 * Claim `scope.key` for this transaction. Resolves null when the key is new (the caller runs the
 * operation and must call `recordResponse` before committing), or the stored response to replay.
 *
 * When another transaction holds an uncommitted claim on the same key, the INSERT waits for it:
 * if it commits, its response is replayed here; if it rolls back, this call claims the key.
 */
export async function claimKey(
  db: Queryable,
  scope: IdempotencyScope,
  now: Date,
): Promise<StoredResponse | null> {
  const inserted = await idempotencyKeys.insertKeyIfAbsent(db, {
    tenantId: scope.tenantId,
    key: scope.key,
    requestHash: scope.requestHash,
    createdAt: now,
  });
  if (inserted) return null;

  const existing = await idempotencyKeys.findKey(db, scope.tenantId, scope.key);
  if (!existing) {
    // Only possible if the row was deleted between the two statements.
    throw new ConflictError(`Idempotency-Key ${scope.key} is being reused concurrently, retry`);
  }
  if (existing.requestHash !== scope.requestHash) {
    throw new IdempotencyConflictError(scope.key);
  }
  if (existing.responseStatus === null || existing.responseBody === null) {
    throw new ConflictError(`a request with Idempotency-Key ${scope.key} is still in progress`);
  }
  return { status: existing.responseStatus, body: existing.responseBody };
}

export async function recordResponse(
  db: Queryable,
  scope: IdempotencyScope,
  response: StoredResponse,
): Promise<void> {
  await idempotencyKeys.saveResponse(db, scope.tenantId, scope.key, response);
}

/**
 * Run `execute` at most once per key within the caller's transaction and return its response,
 * or the response stored by the request that used the key first.
 */
export async function runIdempotent(
  db: Queryable,
  scope: IdempotencyScope,
  now: Date,
  execute: () => Promise<StoredResponse>,
): Promise<IdempotentResult> {
  const stored = await claimKey(db, scope, now);
  if (stored) {
    return { response: stored, replayed: true };
  }
  const response = await execute();
  await recordResponse(db, scope, response);
  return { response, replayed: false };
}
