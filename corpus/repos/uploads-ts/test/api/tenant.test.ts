import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildTestApp, type TestApp } from "../helpers/app.js";
import {
  createTenant,
  expectStatus,
  issueKey,
  putFile,
  storeFile,
  type TenantBody,
  type TestTenant,
} from "../helpers/fixtures.js";

describe("tenant usage and quota", () => {
  let t: TestApp;
  let tenant: TestTenant;

  beforeEach(async () => {
    t = await buildTestApp();
    tenant = await createTenant(t.pool, t.clock, { quotaBytes: 1000 });
  });

  afterEach(async () => {
    await t.close();
  });

  it("reports usage", async () => {
    await storeFile(t.app, tenant, "a.txt", "x".repeat(250));
    const response = await t.app.inject({ url: "/v1/tenant", headers: tenant.headers });
    expectStatus(response, 200);
    expect(response.json<TenantBody>()).toMatchObject({
      id: tenant.tenantId,
      name: "Northwind Archive",
      quotaBytes: 1000,
      usedBytes: 250,
      availableBytes: 750,
    });
  });

  it("lets an admin key lower the quota below usage, which only blocks new bytes", async () => {
    await storeFile(t.app, tenant, "a.txt", "x".repeat(250));
    const response = await t.app.inject({
      method: "PATCH",
      url: "/v1/tenant",
      headers: tenant.headers,
      payload: { quotaBytes: 100 },
    });
    expectStatus(response, 200);
    expect(response.json<TenantBody>()).toMatchObject({ quotaBytes: 100, usedBytes: 250, availableBytes: 0 });
    expectStatus(await putFile(t.app, tenant, "b.txt", "y"), 422);
    expectStatus(await t.app.inject({ url: "/v1/files/by-id/00000000-0000-4000-8000-000000000000/meta", headers: tenant.headers }), 404);
  });

  it("refuses quota changes without tenant:admin and invalid quotas", async () => {
    const reader = await issueKey(t.pool, t.clock, tenant.tenantId, ["tenant:read"]);
    expectStatus(
      await t.app.inject({ method: "PATCH", url: "/v1/tenant", headers: reader.headers, payload: { quotaBytes: 5 } }),
      403,
    );
    for (const quotaBytes of [-1, 1.5, "100"]) {
      expectStatus(
        await t.app.inject({ method: "PATCH", url: "/v1/tenant", headers: tenant.headers, payload: { quotaBytes } }),
        400,
      );
    }
  });
});
