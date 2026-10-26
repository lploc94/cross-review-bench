import type { Queryable } from "../db/pool.js";
import type { Tenant } from "../domain/tenant.js";
import { firstRow, requireRow } from "./mapping.js";

interface TenantRow {
  id: string;
  name: string;
  created_at: Date;
}

function mapTenant(row: TenantRow): Tenant {
  return { id: row.id, name: row.name, createdAt: row.created_at };
}

export async function insertTenant(db: Queryable, name: string, createdAt: Date): Promise<Tenant> {
  const result = await db.query<TenantRow>(
    "INSERT INTO tenants (name, created_at) VALUES ($1, $2) RETURNING id, name, created_at",
    [name, createdAt],
  );
  return mapTenant(requireRow(result.rows, "insertTenant"));
}

export async function findTenant(db: Queryable, id: string): Promise<Tenant | null> {
  const result = await db.query<TenantRow>(
    "SELECT id, name, created_at FROM tenants WHERE id = $1",
    [id],
  );
  const row = firstRow(result.rows);
  return row ? mapTenant(row) : null;
}
