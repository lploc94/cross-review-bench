import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { CurrencyCode } from "../../src/domain/currency.js";
import { parseRate } from "../../src/domain/fx.js";
import * as fxRates from "../../src/repositories/fxRates.js";
import { buildTestApp, type TestApp } from "../helpers/app.js";
import { createTenant, issueKey, type ErrorResponse, type TestTenant } from "../helpers/fixtures.js";

describe("fx", () => {
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

  function seed(base: CurrencyCode, quote: CurrencyCode, rate: string, effectiveAt: string, tenantId = tenant.tenantId) {
    return fxRates.upsertRate(t.pool, {
      tenantId,
      base,
      quote,
      rateScaled: parseRate(rate),
      effectiveAt: new Date(effectiveAt),
    });
  }

  it("returns the latest rate already in effect", async () => {
    t.clock.set("2030-03-01T12:00:00.000Z");
    await seed("EUR", "USD", "1.07", "2030-02-01T00:00:00Z");
    await seed("EUR", "USD", "1.085", "2030-03-01T00:00:00Z");
    await seed("EUR", "USD", "1.2", "2030-03-02T00:00:00Z");

    const response = await t.app.inject({ method: "GET", url: "/fx/rates/EUR/USD", headers: tenant.headers });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      base: "EUR",
      quote: "USD",
      rate: "1.08500000",
      rate_scaled: "108500000",
      effective_at: "2030-03-01T00:00:00.000Z",
    });
  });

  it("uses a rate from the instant it takes effect", async () => {
    await seed("EUR", "USD", "1.07", "2030-02-01T00:00:00Z");
    await seed("EUR", "USD", "1.085", "2030-03-01T00:00:00Z");
    t.clock.set("2030-03-01T00:00:00.000Z");
    const response = await t.app.inject({ method: "GET", url: "/fx/rates/EUR/USD", headers: tenant.headers });
    expect(response.json<{ rate: string }>().rate).toBe("1.08500000");
  });

  it("answers 404 when no rate is in effect and does not invert the opposite pair", async () => {
    await seed("USD", "EUR", "0.92", "2020-01-01T00:00:00Z");
    const response = await t.app.inject({ method: "GET", url: "/fx/rates/EUR/USD", headers: tenant.headers });
    expect(response.statusCode).toBe(404);
    expect(response.json<ErrorResponse>().error.code).toBe("not_found");
  });

  it("only sees the tenant's own rates", async () => {
    const other = await createTenant(t.pool, t.clock, { name: "Other" });
    await seed("GBP", "CHF", "1.12", "2020-01-01T00:00:00Z", other.tenantId);
    const response = await t.app.inject({ method: "GET", url: "/fx/rates/GBP/CHF", headers: tenant.headers });
    expect(response.statusCode).toBe(404);
  });

  it("quotes a conversion across exponents, rounding half to even", async () => {
    await seed("USD", "JPY", "150.25", "2020-01-01T00:00:00Z");
    const response = await t.app.inject({
      method: "GET",
      url: "/fx/quote?from=USD&to=JPY&amount=1000",
      headers: tenant.headers,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      from: "USD",
      to: "JPY",
      amount: "1000",
      converted_amount: "1502",
      rate: "150.25000000",
    });
  });

  it("quotes a currency against itself at 1", async () => {
    const response = await t.app.inject({
      method: "GET",
      url: "/fx/quote?from=KWD&to=KWD&amount=1005",
      headers: tenant.headers,
    });
    expect(response.json()).toMatchObject({ converted_amount: "1005", rate: "1.00000000" });
  });

  it("validates currencies and amounts and requires fx:read", async () => {
    for (const query of ["from=USD&to=ABC&amount=1", "from=USD&to=EUR&amount=1.5", "from=USD&to=EUR"]) {
      const response = await t.app.inject({ method: "GET", url: `/fx/quote?${query}`, headers: tenant.headers });
      expect(response.statusCode, query).toBe(400);
    }
    const noFx = await issueKey(t.pool, t.clock, tenant.tenantId, ["accounts:read"]);
    const response = await t.app.inject({ method: "GET", url: "/fx/rates/EUR/USD", headers: noFx.headers });
    expect(response.statusCode).toBe(403);
  });
});
