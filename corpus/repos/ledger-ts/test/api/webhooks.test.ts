import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { MAX_ACTIVE_ENDPOINTS } from "../../src/services/webhookService.js";
import { buildTestApp, type TestApp } from "../helpers/app.js";
import { createTenant, issueKey, type TestTenant } from "../helpers/fixtures.js";

interface EndpointBody {
  id: string;
  url: string;
  active: boolean;
  created_at: string;
  secret?: string;
}

describe("webhook endpoints", () => {
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

  function create(url: string, owner: TestTenant = tenant) {
    return t.app.inject({ method: "POST", url: "/webhooks", headers: owner.headers, payload: { url } });
  }

  it("returns the signing secret only when the endpoint is created", async () => {
    const created = await create("https://hooks.example.com/ledger");
    expect(created.statusCode).toBe(201);
    const body = created.json<EndpointBody>();
    expect(body.secret).toMatch(/^whsec_[0-9a-f]{64}$/);

    const listed = await t.app.inject({ method: "GET", url: "/webhooks", headers: tenant.headers });
    expect(listed.json<{ data: EndpointBody[] }>().data).toEqual([
      { id: body.id, url: "https://hooks.example.com/ledger", active: true, created_at: body.created_at },
    ]);
  });

  it("deletes an endpoint once and only for its tenant", async () => {
    const { id } = (await create("https://hooks.example.com/a")).json<EndpointBody>();
    const other = await createTenant(t.pool, t.clock, { name: "Other" });

    expect((await t.app.inject({ method: "DELETE", url: `/webhooks/${id}`, headers: other.headers })).statusCode).toBe(404);
    expect((await t.app.inject({ method: "DELETE", url: `/webhooks/${id}`, headers: tenant.headers })).statusCode).toBe(204);
    expect((await t.app.inject({ method: "DELETE", url: `/webhooks/${id}`, headers: tenant.headers })).statusCode).toBe(404);

    const listed = await t.app.inject({ method: "GET", url: "/webhooks", headers: tenant.headers });
    expect(listed.json<{ data: EndpointBody[] }>().data).toEqual([]);
  });

  it("accepts only http(s) URLs", async () => {
    for (const url of ["ftp://hooks.example.com", "not a url", "javascript:alert(1)"]) {
      expect((await create(url)).statusCode, url).toBe(400);
    }
  });

  it("limits the number of active endpoints per tenant", async () => {
    for (let i = 0; i < MAX_ACTIVE_ENDPOINTS; i++) {
      expect((await create(`https://hooks.example.com/${i}`)).statusCode).toBe(201);
    }
    expect((await create("https://hooks.example.com/one-more")).statusCode).toBe(409);
  });

  it("requires the webhooks:manage scope", async () => {
    const reader = await issueKey(t.pool, t.clock, tenant.tenantId, ["accounts:read", "transfers:read"]);
    expect((await t.app.inject({ method: "GET", url: "/webhooks", headers: reader.headers })).statusCode).toBe(403);
  });
});
