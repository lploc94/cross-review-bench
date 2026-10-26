import type { Queryable } from "../db/pool.js";
import type { JsonValue } from "../domain/json.js";
import { firstRow } from "./mapping.js";

export interface IdempotencyRecord {
  readonly tenantId: string;
  readonly key: string;
  readonly requestHash: string;
  readonly responseStatus: number | null;
  readonly responseBody: JsonValue | null;
  readonly createdAt: Date;
}

interface IdempotencyRow {
  tenant_id: string;
  key: string;
  request_hash: string;
  response_status: number | null;
  response_body: JsonValue | null;
  created_at: Date;
}

function mapRecord(row: IdempotencyRow): IdempotencyRecord {
  return {
    tenantId: row.tenant_id,
    key: row.key,
    requestHash: row.request_hash,
    responseStatus: row.response_status,
    responseBody: row.response_body,
    createdAt: row.created_at,
  };
}

/**
 * Insert the key unless the tenant already has it. A concurrent transaction that inserted the
 * same key first makes this statement wait for it to finish. True when this call inserted it.
 */
export async function insertKeyIfAbsent(
  db: Queryable,
  record: { tenantId: string; key: string; requestHash: string; createdAt: Date },
): Promise<boolean> {
  const result = await db.query(
    `INSERT INTO idempotency_keys (tenant_id, key, request_hash, created_at)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (tenant_id, key) DO NOTHING`,
    [record.tenantId, record.key, record.requestHash, record.createdAt],
  );
  return result.rowCount === 1;
}

export async function findKey(
  db: Queryable,
  tenantId: string,
  key: string,
): Promise<IdempotencyRecord | null> {
  const result = await db.query<IdempotencyRow>(
    `SELECT tenant_id, key, request_hash, response_status, response_body, created_at
     FROM idempotency_keys
     WHERE tenant_id = $1 AND key = $2`,
    [tenantId, key],
  );
  const row = firstRow(result.rows);
  return row ? mapRecord(row) : null;
}

export async function saveResponse(
  db: Queryable,
  tenantId: string,
  key: string,
  response: { status: number; body: JsonValue },
): Promise<void> {
  await db.query(
    `UPDATE idempotency_keys SET response_status = $3, response_body = $4::jsonb
     WHERE tenant_id = $1 AND key = $2`,
    [tenantId, key, response.status, JSON.stringify(response.body)],
  );
}
