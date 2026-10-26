import { afterEach, describe, expect, it } from "vitest";
import { buildTestApp, type TestApp } from "../helpers/app.js";
import { createTenant, issueKey, type ErrorResponse } from "../helpers/fixtures.js";

describe("per-key rate limit", () => {
  let t: TestApp | undefined;

  afterEach(async () => {
    await t?.close();
    t = undefined;
  });

  it("answers 429 with Retry-After once the minute's budget is spent", async () => {
    t = await buildTestApp({ env: { RATE_LIMIT_PER_MINUTE: "3" } });
    t.clock.set("2030-01-15T10:00:15.000Z");
    const tenant = await createTenant(t.pool, t.clock);

    const statuses: number[] = [];
    for (let i = 0; i < 3; i++) {
      const response = await t.app.inject({ method: "GET", url: "/accounts", headers: tenant.headers });
      statuses.push(response.statusCode);
      expect(response.headers["x-ratelimit-remaining"]).toBe(String(2 - i));
    }
    expect(statuses).toEqual([200, 200, 200]);

    const limited = await t.app.inject({ method: "GET", url: "/accounts", headers: tenant.headers });
    expect(limited.statusCode).toBe(429);
    expect(limited.headers["retry-after"]).toBe("45");
    expect(limited.json<ErrorResponse>().error.code).toBe("rate_limited");
  });

  it("opens a new budget when the next minute starts", async () => {
    t = await buildTestApp({ env: { RATE_LIMIT_PER_MINUTE: "1" } });
    t.clock.set("2030-01-15T10:00:59.000Z");
    const tenant = await createTenant(t.pool, t.clock);

    expect((await t.app.inject({ method: "GET", url: "/accounts", headers: tenant.headers })).statusCode).toBe(200);
    const limited = await t.app.inject({ method: "GET", url: "/accounts", headers: tenant.headers });
    expect(limited.statusCode).toBe(429);
    expect(limited.headers["retry-after"]).toBe("1");

    t.clock.advanceSeconds(1);
    expect((await t.app.inject({ method: "GET", url: "/accounts", headers: tenant.headers })).statusCode).toBe(200);
  });

  it("counts each API key separately", async () => {
    t = await buildTestApp({ env: { RATE_LIMIT_PER_MINUTE: "1" } });
    const tenant = await createTenant(t.pool, t.clock);
    const second = await issueKey(t.pool, t.clock, tenant.tenantId, ["accounts:read"]);

    expect((await t.app.inject({ method: "GET", url: "/accounts", headers: tenant.headers })).statusCode).toBe(200);
    expect((await t.app.inject({ method: "GET", url: "/accounts", headers: tenant.headers })).statusCode).toBe(429);
    expect((await t.app.inject({ method: "GET", url: "/accounts", headers: second.headers })).statusCode).toBe(200);
  });

  it("lets requests through when the limiter is unavailable", async () => {
    t = await buildTestApp({
      rateLimiter: {
        consume: () => Promise.reject(new Error("connection refused")),
      },
    });
    const tenant = await createTenant(t.pool, t.clock);
    const response = await t.app.inject({ method: "GET", url: "/accounts", headers: tenant.headers });
    expect(response.statusCode).toBe(200);
  });

  it("does not count unauthenticated requests against a key", async () => {
    t = await buildTestApp({ env: { RATE_LIMIT_PER_MINUTE: "1" } });
    const tenant = await createTenant(t.pool, t.clock);
    for (let i = 0; i < 3; i++) {
      await t.app.inject({ method: "GET", url: "/accounts", headers: { authorization: "Bearer lk_bad" } });
    }
    expect((await t.app.inject({ method: "GET", url: "/accounts", headers: tenant.headers })).statusCode).toBe(200);
  });
});
