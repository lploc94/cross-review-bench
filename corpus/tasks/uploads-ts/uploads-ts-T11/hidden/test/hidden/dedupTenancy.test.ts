import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { UploadBody } from "../../src/api/serializers.js";
import { buildTestApp, type TestApp } from "../helpers/app.js";
import {
  createTenant,
  expectStatus,
  markAvailable,
  multipartBody,
  putFile,
  storeFile,
  type SessionBody,
  type TestTenant,
} from "../helpers/fixtures.js";

type UploadRoute = "put" | "multipart" | "resumable";

const UPLOAD_ROUTES: readonly UploadRoute[] = ["put", "multipart", "resumable"];

/** Upload `body` to `filePath` through one of the three upload routes; returns the final answer. */
async function uploadThrough(
  route: UploadRoute,
  app: FastifyInstance,
  tenant: TestTenant,
  filePath: string,
  body: Buffer,
): Promise<LightMyRequestResponse> {
  if (route === "put") return putFile(app, tenant, filePath, body);
  if (route === "multipart") {
    const form = multipartBody([
      { name: "path", value: filePath },
      { name: "file", filename: "upload.bin", contentType: "application/octet-stream", content: body },
    ]);
    return app.inject({
      method: "POST",
      url: "/v1/files",
      headers: { ...tenant.headers, "content-type": form.contentType },
      payload: form.payload,
    });
  }
  const created = await app.inject({
    method: "POST",
    url: "/v1/uploads",
    headers: tenant.headers,
    payload: { path: filePath, size: body.length },
  });
  expectStatus(created, 201);
  const session = created.json<SessionBody>();
  const patched = await app.inject({
    method: "PATCH",
    url: `/v1/uploads/${session.id}`,
    headers: { ...tenant.headers, "upload-offset": "0", "content-type": "application/offset+octet-stream" },
    payload: body,
  });
  expectStatus(patched, 204);
  return app.inject({ method: "POST", url: `/v1/uploads/${session.id}/complete`, headers: tenant.headers });
}

describe("deduplication across tenants", () => {
  let t: TestApp;
  let owner: TestTenant;
  let other: TestTenant;

  beforeEach(async () => {
    t = await buildTestApp();
    owner = await createTenant(t.pool, t.clock, { name: "Harbor Logistics" });
    other = await createTenant(t.pool, t.clock, { name: "Maple Street Dental" });
  });

  afterEach(async () => {
    await t.close();
  });

  async function storageKeyOf(fileId: string): Promise<string | undefined> {
    const result = await t.pool.query<{ storage_key: string }>("SELECT storage_key FROM files WHERE id = $1", [
      fileId,
    ]);
    return result.rows[0]?.storage_key;
  }

  for (const route of UPLOAD_ROUTES) {
    it(`never links another tenant's object (${route})`, async () => {
      const content = Buffer.from(`payroll export 2030-01, ${route}`);
      const original = await storeFile(t.app, owner, "exports/payroll.csv", content);
      await markAvailable(t.pool, original.id);

      const response = await uploadThrough(route, t.app, other, "inbox/payroll.csv", content);
      expect(response.statusCode).toBeLessThan(300);
      const file = response.json<UploadBody>();
      expect(file.deduplicated).toBe(false);
      expect(await storageKeyOf(file.id)).toBe(`t/${other.tenantId}/${file.id}`);
      expect(await storageKeyOf(original.id)).toBe(`t/${owner.tenantId}/${original.id}`);
    });
  }
});
