import type { Queryable } from "../db/pool.js";
import type { Tenant } from "../domain/tenant.js";
import type { Logger } from "../infra/logger.js";
import { firstRow, requireRow, toSafeInteger } from "./mapping.js";

interface TenantRow {
  id: string;
  name: string;
  quota_bytes: string;
  used_bytes: string;
  created_at: Date;
}

const COLUMNS = "id, name, quota_bytes, used_bytes, created_at";

function mapTenant(row: TenantRow): Tenant {
  return {
    id: row.id,
    name: row.name,
    quotaBytes: toSafeInteger(row.quota_bytes, "tenants.quota_bytes"),
    usedBytes: toSafeInteger(row.used_bytes, "tenants.used_bytes"),
    createdAt: row.created_at,
  };
}

export async function insertTenant(
  db: Queryable,
  tenant: { name: string; quotaBytes: number; createdAt: Date },
): Promise<Tenant> {
  const result = await db.query<TenantRow>(
    `INSERT INTO tenants (name, quota_bytes, created_at) VALUES ($1, $2, $3) RETURNING ${COLUMNS}`,
    [tenant.name, tenant.quotaBytes, tenant.createdAt],
  );
  return mapTenant(requireRow(result.rows, "insertTenant"));
}

export async function findTenant(db: Queryable, id: string): Promise<Tenant | null> {
  const result = await db.query<TenantRow>(`SELECT ${COLUMNS} FROM tenants WHERE id = $1`, [id]);
  const row = firstRow(result.rows);
  return row ? mapTenant(row) : null;
}

export async function updateQuota(
  db: Queryable,
  id: string,
  quotaBytes: number,
): Promise<Tenant | null> {
  const result = await db.query<TenantRow>(
    `UPDATE tenants SET quota_bytes = $2 WHERE id = $1 RETURNING ${COLUMNS}`,
    [id, quotaBytes],
  );
  const row = firstRow(result.rows);
  return row ? mapTenant(row) : null;
}

/**
 * Reserve `bytes` of the tenant's quota: one conditional UPDATE, so concurrent reservations can
 * never together pass the quota. Returns false, changing nothing, when the bytes do not fit.
 * This and `releaseBytes` are the only statements that change `used_bytes`.
 */
export async function reserveBytes(db: Queryable, tenantId: string, bytes: number): Promise<boolean> {
  if (!Number.isSafeInteger(bytes) || bytes < 0) {
    throw new Error(`cannot reserve ${bytes} bytes`);
  }
  const result = await db.query(
    `UPDATE tenants SET used_bytes = used_bytes + $2
     WHERE id = $1 AND used_bytes + $2 <= quota_bytes`,
    [tenantId, bytes],
  );
  return result.rowCount === 1;
}

/**
 * Give `bytes` back to the tenant's quota. Usage never goes below zero; a release larger than
 * the usage means the books were already off, so it is logged.
 */
export async function releaseBytes(
  db: Queryable,
  tenantId: string,
  bytes: number,
  logger: Pick<Logger, "warn">,
): Promise<void> {
  if (!Number.isSafeInteger(bytes) || bytes < 0) {
    throw new Error(`cannot release ${bytes} bytes`);
  }
  if (bytes === 0) return;
  const result = await db.query<{ previous: string }>(
    `WITH previous AS (SELECT used_bytes FROM tenants WHERE id = $1 FOR UPDATE)
     UPDATE tenants SET used_bytes = GREATEST(tenants.used_bytes - $2, 0)
     FROM previous
     WHERE tenants.id = $1
     RETURNING previous.used_bytes AS previous`,
    [tenantId, bytes],
  );
  const row = firstRow(result.rows);
  if (row && toSafeInteger(row.previous, "tenants.used_bytes") < bytes) {
    logger.warn(
      { tenantId, releasedBytes: bytes, usedBytes: Number(row.previous) },
      "released more bytes than the tenant was using; usage clamped at zero",
    );
  }
}
