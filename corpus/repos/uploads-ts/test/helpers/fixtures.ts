import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { SCOPES, type Scope } from "../../src/domain/scopes.js";
import type { Pool } from "../../src/db/pool.js";
import type { Clock } from "../../src/infra/clock.js";
import { ApiKeyService } from "../../src/services/apiKeyService.js";
import { TenantService } from "../../src/services/tenantService.js";
import type { FileBody } from "../../src/api/serializers.js";

export type { FileBody };

export interface TestTenant {
  readonly tenantId: string;
  readonly apiKeyId: string;
  readonly token: string;
  readonly headers: { authorization: string };
}

export interface ErrorResponse {
  error: { code: string; message: string; details?: Record<string, unknown> };
}

export interface SessionBody {
  id: string;
  path: string;
  size: number;
  offset: number;
  state: string;
  declaredType: string | null;
  overwrite: boolean;
  fileId: string | null;
  createdAt: string;
  expiresAt: string;
}

export interface TenantBody {
  id: string;
  name: string;
  quotaBytes: number;
  usedBytes: number;
  availableBytes: number;
}

/** A tenant with a quota (1 MiB by default) and one API key holding `scopes` (all by default). */
export async function createTenant(
  pool: Pool,
  clock: Clock,
  options: { name?: string; quotaBytes?: number; scopes?: readonly Scope[] } = {},
): Promise<TestTenant> {
  const tenant = await new TenantService({ pool, clock }).createTenant(
    options.name ?? "Northwind Archive",
    options.quotaBytes ?? 1024 * 1024,
  );
  return issueKey(pool, clock, tenant.id, options.scopes ?? SCOPES);
}

/** Another API key for an existing tenant. */
export async function issueKey(
  pool: Pool,
  clock: Clock,
  tenantId: string,
  scopes: readonly Scope[],
): Promise<TestTenant> {
  const issued = await new ApiKeyService({ pool, clock }).issueKey(tenantId, "test key", scopes);
  return {
    tenantId,
    apiKeyId: issued.key.id,
    token: issued.token,
    headers: { authorization: `Bearer ${issued.token}` },
  };
}

export function expectStatus(response: LightMyRequestResponse, status: number): void {
  if (response.statusCode !== status) {
    throw new Error(`expected HTTP ${status}, got ${response.statusCode}: ${response.body}`);
  }
}

/** `PUT /v1/files/<path>` with a raw body. */
export function putFile(
  app: FastifyInstance,
  tenant: TestTenant,
  path: string,
  body: Buffer | string,
  options: { contentType?: string; overwrite?: boolean } = {},
): Promise<LightMyRequestResponse> {
  const encoded = path.split("/").map(encodeURIComponent).join("/");
  return app.inject({
    method: "PUT",
    url: `/v1/files/${encoded}${options.overwrite ? "?overwrite=true" : ""}`,
    headers: { ...tenant.headers, "content-type": options.contentType ?? "application/octet-stream" },
    payload: body,
  });
}

/** Upload a file and return its metadata, failing the test on anything but 201. */
export async function storeFile(
  app: FastifyInstance,
  tenant: TestTenant,
  path: string,
  body: Buffer | string,
  options: { contentType?: string } = {},
): Promise<FileBody> {
  const response = await putFile(app, tenant, path, body, options);
  expectStatus(response, 201);
  return response.json<FileBody>();
}

export interface FormField {
  readonly name: string;
  readonly value: string;
}

export interface FormFile {
  readonly name: string;
  readonly filename: string;
  readonly contentType: string;
  readonly content: Buffer;
}

/** A multipart/form-data body with the parts in the order given. */
export function multipartBody(parts: readonly (FormField | FormFile)[]): {
  payload: Buffer;
  contentType: string;
} {
  const boundary = "----uploads-test-boundary-7d3f";
  const chunks: Buffer[] = [];
  for (const part of parts) {
    chunks.push(Buffer.from(`--${boundary}\r\n`));
    if ("content" in part) {
      chunks.push(
        Buffer.from(
          `Content-Disposition: form-data; name="${part.name}"; filename="${part.filename}"\r\n` +
            `Content-Type: ${part.contentType}\r\n\r\n`,
        ),
      );
      chunks.push(part.content, Buffer.from("\r\n"));
    } else {
      chunks.push(Buffer.from(`Content-Disposition: form-data; name="${part.name}"\r\n\r\n${part.value}\r\n`));
    }
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { payload: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` };
}

/** Mark a file scanned and clean, so it can be downloaded. */
export async function markAvailable(pool: Pool, fileId: string): Promise<void> {
  await pool.query("UPDATE files SET status = 'available', next_scan_at = NULL WHERE id = $1", [fileId]);
}

export async function tenantUsage(pool: Pool, tenantId: string): Promise<number> {
  const result = await pool.query<{ used_bytes: string }>(
    "SELECT used_bytes FROM tenants WHERE id = $1",
    [tenantId],
  );
  return Number(result.rows[0]?.used_bytes);
}
