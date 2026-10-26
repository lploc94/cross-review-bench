import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildTestApp, type TestApp } from "../helpers/app.js";
import {
  createTenant,
  expectStatus,
  multipartBody,
  putFile,
  tenantUsage,
  type ErrorResponse,
  type SessionBody,
  type TenantBody,
  type TestTenant,
} from "../helpers/fixtures.js";

describe("tenant upload limit (behaviour)", () => {
  let t: TestApp;
  let tenant: TestTenant;

  beforeEach(async () => {
    t = await buildTestApp({ env: { MAX_UPLOAD_BYTES: "4096" } });
    tenant = await createTenant(t.pool, t.clock, { quotaBytes: 50_000 });
  });

  afterEach(async () => {
    await t.close();
  });

  async function patch(payload: object): Promise<TenantBody> {
    const response = await t.app.inject({ method: "PATCH", url: "/v1/tenant", headers: tenant.headers, payload });
    expectStatus(response, 200);
    return response.json<TenantBody>();
  }

  it("accepts a limit equal to the service's and keeps the quota untouched", async () => {
    expect(await patch({ maxUploadBytes: 4096 })).toMatchObject({ maxUploadBytes: 4096, quotaBytes: 50_000 });
    expectStatus(await putFile(t.app, tenant, "full.bin", Buffer.alloc(4096)), 201);
  });

  it("goes back to the service's limit once cleared", async () => {
    await patch({ maxUploadBytes: 100 });
    expectStatus(await putFile(t.app, tenant, "a.bin", Buffer.alloc(101)), 413);
    await patch({ maxUploadBytes: null });
    expectStatus(await putFile(t.app, tenant, "a.bin", Buffer.alloc(4000)), 201);
  });

  it("applies the limit to a replacement as to a new file", async () => {
    expectStatus(await putFile(t.app, tenant, "doc.bin", Buffer.alloc(3000)), 201);
    await patch({ maxUploadBytes: 2000 });
    const replaced = await putFile(t.app, tenant, "doc.bin", Buffer.alloc(2500), { overwrite: true });
    expectStatus(replaced, 413);
    expect(replaced.json<ErrorResponse>().error.details).toEqual({ limitBytes: 2000 });
    expect(await tenantUsage(t.pool, tenant.tenantId)).toBe(3000);
    expectStatus(await putFile(t.app, tenant, "doc.bin", Buffer.alloc(2000), { overwrite: true }), 200);
    expect(await tenantUsage(t.pool, tenant.tenantId)).toBe(2000);
  });

  it("accepts a multipart file of exactly the limit", async () => {
    await patch({ maxUploadBytes: 1500 });
    const form = multipartBody([
      { name: "path", value: "form.bin" },
      { name: "file", filename: "form.bin", contentType: "application/octet-stream", content: Buffer.alloc(1500, 7) },
    ]);
    const response = await t.app.inject({
      method: "POST",
      url: "/v1/files",
      headers: { ...tenant.headers, "content-type": form.contentType },
      payload: form.payload,
    });
    expectStatus(response, 201);
    expect(response.json<{ size: number }>().size).toBe(1500);
  });

  it("lets a session created before the limit was lowered finish", async () => {
    const created = await t.app.inject({
      method: "POST",
      url: "/v1/uploads",
      headers: tenant.headers,
      payload: { path: "early.bin", size: 3000 },
    });
    expectStatus(created, 201);
    const session = created.json<SessionBody>();
    await patch({ maxUploadBytes: 1000 });
    const chunk = await t.app.inject({
      method: "PATCH",
      url: `/v1/uploads/${session.id}`,
      headers: { ...tenant.headers, "upload-offset": "0", "content-type": "application/offset+octet-stream" },
      payload: Buffer.alloc(3000, 3),
    });
    expectStatus(chunk, 204);
    const done = await t.app.inject({
      method: "POST",
      url: `/v1/uploads/${session.id}/complete`,
      headers: tenant.headers,
    });
    expectStatus(done, 201);
    expect(done.json<{ size: number }>().size).toBe(3000);

    const later = await t.app.inject({
      method: "POST",
      url: "/v1/uploads",
      headers: tenant.headers,
      payload: { path: "late.bin", size: 3000 },
    });
    expectStatus(later, 413);
  });
});
