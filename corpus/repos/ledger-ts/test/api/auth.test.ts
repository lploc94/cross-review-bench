import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import * as apiKeys from "../../src/repositories/apiKeys.js";
import { buildTestApp, type TestApp } from "../helpers/app.js";
import {
  createTenant,
  fundedWallet,
  issueKey,
  openAccount,
  transferRequest,
  type ErrorResponse,
  type TestTenant,
} from "../helpers/fixtures.js";

describe("authentication and authorization", () => {
  let t: TestApp;
  let tenant: TestTenant;

  beforeAll(async () => {
    t = await buildTestApp();
  });

  afterAll(async () => {
    await t.close();
  });

  beforeEach(async () => {
    tenant = await createTenant(t.pool, t.clock);
  });

  it("serves the liveness check without credentials", async () => {
    const response = await t.app.inject({ method: "GET", url: "/health/live" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok" });
  });

  it("rejects requests without an Authorization header", async () => {
    const response = await t.app.inject({ method: "GET", url: "/accounts" });
    expect(response.statusCode).toBe(401);
    expect(response.json<ErrorResponse>().error.code).toBe("unauthorized");
  });

  it("rejects other authorization schemes and malformed tokens", async () => {
    for (const authorization of [`Basic ${tenant.token}`, "Bearer", "Bearer lk_nope", `Bearer ${tenant.token}x`]) {
      const response = await t.app.inject({ method: "GET", url: "/accounts", headers: { authorization } });
      expect(response.statusCode).toBe(401);
    }
  });

  it("rejects a known prefix with the wrong secret", async () => {
    const [, prefix] = tenant.token.split("_");
    const forged = `lk_${prefix}_${"0".repeat(64)}`;
    const response = await t.app.inject({
      method: "GET",
      url: "/accounts",
      headers: { authorization: `Bearer ${forged}` },
    });
    expect(response.statusCode).toBe(401);
  });

  it("rejects revoked keys", async () => {
    await apiKeys.revokeApiKey(t.pool, tenant.tenantId, tenant.apiKeyId, t.clock.now());
    const response = await t.app.inject({ method: "GET", url: "/accounts", headers: tenant.headers });
    expect(response.statusCode).toBe(401);
  });

  it("answers 403 when the key lacks the route's scope", async () => {
    const reader = await issueKey(t.pool, t.clock, tenant.tenantId, ["accounts:read"]);
    const response = await t.app.inject({
      method: "POST",
      url: "/accounts",
      headers: reader.headers,
      payload: { name: "wallet", currency: "USD" },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json<ErrorResponse>().error).toMatchObject({
      code: "forbidden",
      details: { required_scope: "accounts:write" },
    });
  });

  it("does not treat a write scope as implying the read scope", async () => {
    const writer = await issueKey(t.pool, t.clock, tenant.tenantId, ["accounts:write"]);
    const created = await t.app.inject({
      method: "POST",
      url: "/accounts",
      headers: writer.headers,
      payload: { name: "wallet", currency: "USD" },
    });
    expect(created.statusCode).toBe(201);
    const read = await t.app.inject({ method: "GET", url: "/accounts", headers: writer.headers });
    expect(read.statusCode).toBe(403);
  });

  it("hides other tenants' resources behind 404", async () => {
    const other = await createTenant(t.pool, t.clock, { name: "Other tenant" });
    const wallet = await fundedWallet(t.app, tenant, "1000");
    const theirs = await openAccount(t.app, other);

    const read = await t.app.inject({ method: "GET", url: `/accounts/${wallet.id}`, headers: other.headers });
    expect(read.statusCode).toBe(404);

    const steal = await transferRequest(t.app, other, {
      from_account_id: wallet.id,
      to_account_id: theirs.id,
      amount: "1000",
      currency: "USD",
    });
    expect(steal.statusCode).toBe(404);
  });

  it("answers unknown routes with the standard error body", async () => {
    const response = await t.app.inject({ method: "GET", url: "/nowhere", headers: tenant.headers });
    expect(response.statusCode).toBe(404);
    expect(response.json<ErrorResponse>().error.code).toBe("not_found");
  });
});
