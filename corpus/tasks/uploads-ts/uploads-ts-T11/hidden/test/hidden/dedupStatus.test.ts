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

describe("status of a deduplicated upload", () => {
  let t: TestApp;
  let tenant: TestTenant;

  beforeEach(async () => {
    t = await buildTestApp();
    tenant = await createTenant(t.pool, t.clock);
  });

  afterEach(async () => {
    await t.close();
  });

  for (const route of UPLOAD_ROUTES) {
    it(`answers 201 for a new file whose bytes were already stored (${route})`, async () => {
      const content = Buffer.from(`invoice 4471, ${route}`);
      const original = await storeFile(t.app, tenant, "invoices/4471.txt", content);
      await markAvailable(t.pool, original.id);

      const response = await uploadThrough(route, t.app, tenant, "copies/4471.txt", content);
      expectStatus(response, 201);
      expect(response.json<UploadBody>().deduplicated).toBe(true);
    });
  }

  it("still answers 200 when an overwrite replaces a file", async () => {
    const original = await storeFile(t.app, tenant, "invoices/4472.txt", "invoice 4472");
    await markAvailable(t.pool, original.id);
    await storeFile(t.app, tenant, "copies/4472.txt", "something else");
    const response = await putFile(t.app, tenant, "copies/4472.txt", "invoice 4472", { overwrite: true });
    expectStatus(response, 200);
    expect(response.json<UploadBody>().deduplicated).toBe(true);
  });
});
