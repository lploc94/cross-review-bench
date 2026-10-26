import type { Queryable } from "../db/pool.js";
import type { WebhookEndpoint } from "../domain/webhook.js";
import { firstRow, requireRow } from "./mapping.js";

interface EndpointRow {
  id: string;
  tenant_id: string;
  url: string;
  secret: string;
  active: boolean;
  created_at: Date;
}

const COLUMNS = "id, tenant_id, url, secret, active, created_at";

function mapEndpoint(row: EndpointRow): WebhookEndpoint {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    url: row.url,
    secret: row.secret,
    active: row.active,
    createdAt: row.created_at,
  };
}

export async function insertEndpoint(
  db: Queryable,
  endpoint: { tenantId: string; url: string; secret: string; createdAt: Date },
): Promise<WebhookEndpoint> {
  const result = await db.query<EndpointRow>(
    `INSERT INTO webhook_endpoints (tenant_id, url, secret, created_at)
     VALUES ($1, $2, $3, $4)
     RETURNING ${COLUMNS}`,
    [endpoint.tenantId, endpoint.url, endpoint.secret, endpoint.createdAt],
  );
  return mapEndpoint(requireRow(result.rows, "insertEndpoint"));
}

export async function listActiveEndpoints(
  db: Queryable,
  tenantId: string,
): Promise<WebhookEndpoint[]> {
  const result = await db.query<EndpointRow>(
    `SELECT ${COLUMNS} FROM webhook_endpoints
     WHERE tenant_id = $1 AND active
     ORDER BY created_at, id`,
    [tenantId],
  );
  return result.rows.map(mapEndpoint);
}

export async function countActiveEndpoints(db: Queryable, tenantId: string): Promise<number> {
  const result = await db.query<{ count: string }>(
    "SELECT count(*) AS count FROM webhook_endpoints WHERE tenant_id = $1 AND active",
    [tenantId],
  );
  return Number(requireRow(result.rows, "countActiveEndpoints").count);
}

/** Stop deliveries to an endpoint. False when the tenant has no such active endpoint. */
export async function deactivateEndpoint(
  db: Queryable,
  tenantId: string,
  id: string,
): Promise<boolean> {
  const result = await db.query<EndpointRow>(
    `UPDATE webhook_endpoints SET active = false
     WHERE tenant_id = $1 AND id = $2 AND active
     RETURNING ${COLUMNS}`,
    [tenantId, id],
  );
  return firstRow(result.rows) !== null;
}
