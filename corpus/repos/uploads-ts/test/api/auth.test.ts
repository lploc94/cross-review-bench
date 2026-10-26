import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApiKeyService } from "../../src/services/apiKeyService.js";
import { buildTestApp, type TestApp } from "../helpers/app.js";
import {
  createTenant,
  expectStatus,
  issueKey,
  storeFile,
  type ErrorResponse,
  type TestTenant,
} from "../helpers/fixtures.js";

describe("authentication and scopes", () => {
  let t: TestApp;
  let tenant: TestTenant;

  beforeEach(async () => {
    t = await buildTestApp();
    tenant = await createTenant(t.pool, t.clock);
  });

  afterEach(async () => {
    await t.close();
  });

  it.each([
    [undefined],
    ["Basic dXNlcjpwYXNz"],
    ["Bearer up_short"],
    ["Bearer up_abcdefgh_0000000000000000000000000000000000000000000000000000000000000000"],
  ])("answers 401 to the Authorization header %j", async (authorization) => {
    const response = await t.app.inject({
      url: "/v1/files",
      headers: authorization === undefined ? {} : { authorization },
    });
    expectStatus(response, 401);
    expect(response.json<ErrorResponse>().error.code).toBe("unauthorized");
  });

  it("refuses a key with the right prefix and a wrong secret", async () => {
    const forged = `${tenant.token.slice(0, 12)}${"0".repeat(64)}`;
    const response = await t.app.inject({ url: "/v1/files", headers: { authorization: `Bearer ${forged}` } });
    expectStatus(response, 401);
  });

  it("refuses a revoked key", async () => {
    await new ApiKeyService({ pool: t.pool, clock: t.clock }).revokeKey(tenant.tenantId, tenant.apiKeyId);
    expectStatus(await t.app.inject({ url: "/v1/files", headers: tenant.headers }), 401);
  });

  it("answers 403 when the key lacks the route's scope, before reading an upload", async () => {
    const reader = await issueKey(t.pool, t.clock, tenant.tenantId, ["files:read"]);
    const response = await t.app.inject({
      method: "PUT",
      url: "/v1/files/a.txt",
      headers: { ...reader.headers, "content-type": "text/plain" },
      payload: "x",
    });
    expectStatus(response, 403);
    expect(response.json<ErrorResponse>().error.details).toEqual({ requiredScope: "files:write" });
    expectStatus(await t.app.inject({ url: "/v1/files", headers: reader.headers }), 200);
  });

  it("never shows one tenant's files to another", async () => {
    const file = await storeFile(t.app, tenant, "private.txt", "secret plans");
    const other = await createTenant(t.pool, t.clock, { name: "Harbor Logistics" });
    for (const url of [`/v1/files/by-id/${file.id}/meta`, `/v1/files/by-id/${file.id}`, "/v1/files/private.txt"]) {
      expectStatus(await t.app.inject({ url, headers: other.headers }), 404);
    }
    expectStatus(
      await t.app.inject({ method: "DELETE", url: "/v1/files/private.txt", headers: other.headers }),
      404,
    );
  });

  it("leaves health checks and unknown routes outside authentication", async () => {
    expectStatus(await t.app.inject({ url: "/health/live" }), 200);
    expectStatus(await t.app.inject({ url: "/health/ready" }), 200);
    const missing = await t.app.inject({ url: "/nowhere" });
    expectStatus(missing, 404);
  });
});
