import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildTestApp, type TestApp } from "../helpers/app.js";
import { createTenant, expectStatus, tenantUsage, type ErrorResponse, type TestTenant } from "../helpers/fixtures.js";

describe("presigned upload expiry", () => {
  let t: TestApp;
  let tenant: TestTenant;

  beforeEach(async () => {
    t = await buildTestApp();
    tenant = await createTenant(t.pool, t.clock);
  });

  afterEach(async () => {
    await t.close();
  });

  async function presignedUrl(path: string, expiresIn: number): Promise<string> {
    const response = await t.app.inject({
      method: "POST",
      url: "/v1/uploads/presign",
      headers: tenant.headers,
      payload: { path, size: 5, expiresIn },
    });
    expectStatus(response, 200);
    return response.json<{ url: string }>().url;
  }

  function put(url: string) {
    return t.app.inject({ method: "PUT", url, headers: { "content-type": "text/plain" }, payload: "hello" });
  }

  it("accepts the upload until expiresIn seconds have passed, and refuses it afterwards", async () => {
    const early = await presignedUrl("early.txt", 600);
    const late = await presignedUrl("late.txt", 600);

    t.clock.advanceSeconds(599);
    expectStatus(await put(early), 201);

    t.clock.advanceSeconds(2);
    const response = await put(late);
    expectStatus(response, 403);
    expect(response.json<ErrorResponse>().error.code).toBe("signed_url_expired");
    expect(await tenantUsage(t.pool, tenant.tenantId)).toBe(5);
  });

  it("refuses a short-lived URL used a minute later", async () => {
    const url = await presignedUrl("quick.txt", 30);
    t.clock.advanceSeconds(60);
    const response = await put(url);
    expectStatus(response, 403);
    expect(response.json<ErrorResponse>().error.code).toBe("signed_url_expired");
  });
});
