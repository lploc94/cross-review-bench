import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildTestApp, type TestApp } from "../helpers/app.js";
import { createTenant, openAccount, transfer, type TestTenant } from "../helpers/fixtures.js";

describe("transfer search amount range", () => {
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

  async function amounts(query: string): Promise<string[]> {
    const response = await t.app.inject({
      method: "GET",
      url: `/transfers?currency=USD&limit=100&${query}`,
      headers: tenant.headers,
    });
    expect(response.statusCode, query).toBe(200);
    return response
      .json<{ data: { amount: string }[] }>()
      .data.map((x) => x.amount)
      .sort((a, b) => Number(a) - Number(b));
  }

  it("is half-open: amount_min <= amount < amount_max", async () => {
    const funding = await openAccount(t.app, tenant, { kind: "system" });
    const wallet = await openAccount(t.app, tenant);
    for (const amount of ["999", "1000", "1001", "4999", "5000", "9999", "10000"]) {
      t.clock.advanceSeconds(1);
      await transfer(t.app, tenant, funding.id, wallet.id, amount);
    }
    expect(await amounts("amount_min=1000&amount_max=5000")).toEqual(["1000", "1001", "4999"]);
    expect(await amounts("amount_min=5000&amount_max=10000")).toEqual(["5000", "9999"]);
    expect(await amounts("amount_min=1000&amount_max=1001")).toEqual(["1000"]);
    expect(await amounts("amount_max=1000")).toEqual(["999"]);
    expect(await amounts("amount_min=10000")).toEqual(["10000"]);

    const split = [
      ...(await amounts("amount_max=1000")),
      ...(await amounts("amount_min=1000&amount_max=5000")),
      ...(await amounts("amount_min=5000")),
    ];
    expect(split).toEqual(await amounts(""));
  });
});
