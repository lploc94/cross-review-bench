import type { Queryable } from "../db/pool.js";
import type { ApiKeyRecord } from "../domain/apiKey.js";
import { firstRow, requireRow } from "./mapping.js";

interface ApiKeyRow {
  id: string;
  tenant_id: string;
  name: string;
  prefix: string;
  secret_hash: string;
  scopes: string[];
  created_at: Date;
  revoked_at: Date | null;
}

const COLUMNS = "id, tenant_id, name, prefix, secret_hash, scopes, created_at, revoked_at";

function mapApiKey(row: ApiKeyRow): ApiKeyRecord {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    name: row.name,
    prefix: row.prefix,
    secretHash: row.secret_hash,
    scopes: row.scopes,
    createdAt: row.created_at,
    revokedAt: row.revoked_at,
  };
}

export interface NewApiKey {
  readonly tenantId: string;
  readonly name: string;
  readonly prefix: string;
  readonly secretHash: string;
  readonly scopes: readonly string[];
  readonly createdAt: Date;
}

export async function insertApiKey(db: Queryable, key: NewApiKey): Promise<ApiKeyRecord> {
  const result = await db.query<ApiKeyRow>(
    `INSERT INTO api_keys (tenant_id, name, prefix, secret_hash, scopes, created_at)
     VALUES ($1, $2, $3, $4, $5::text[], $6)
     RETURNING ${COLUMNS}`,
    [key.tenantId, key.name, key.prefix, key.secretHash, key.scopes, key.createdAt],
  );
  return mapApiKey(requireRow(result.rows, "insertApiKey"));
}

/** Look a key up by its public prefix. Prefixes are unique across tenants. */
export async function findApiKeyByPrefix(
  db: Queryable,
  prefix: string,
): Promise<ApiKeyRecord | null> {
  const result = await db.query<ApiKeyRow>(`SELECT ${COLUMNS} FROM api_keys WHERE prefix = $1`, [
    prefix,
  ]);
  const row = firstRow(result.rows);
  return row ? mapApiKey(row) : null;
}

export async function listApiKeys(db: Queryable, tenantId: string): Promise<ApiKeyRecord[]> {
  const result = await db.query<ApiKeyRow>(
    `SELECT ${COLUMNS} FROM api_keys WHERE tenant_id = $1 ORDER BY created_at, id`,
    [tenantId],
  );
  return result.rows.map(mapApiKey);
}

/** Revoke a key; revoking it again keeps the first revocation time. */
export async function revokeApiKey(
  db: Queryable,
  tenantId: string,
  id: string,
  revokedAt: Date,
): Promise<ApiKeyRecord | null> {
  const result = await db.query<ApiKeyRow>(
    `UPDATE api_keys SET revoked_at = COALESCE(revoked_at, $3)
     WHERE tenant_id = $1 AND id = $2
     RETURNING ${COLUMNS}`,
    [tenantId, id, revokedAt],
  );
  const row = firstRow(result.rows);
  return row ? mapApiKey(row) : null;
}
