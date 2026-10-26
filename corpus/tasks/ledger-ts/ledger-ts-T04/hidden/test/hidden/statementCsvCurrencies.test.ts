import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { CurrencyCode } from "../../src/domain/currency.js";
import { buildTestApp, type TestApp } from "../helpers/app.js";
import { createTenant, fundedWallet, openAccount, transfer, type TestTenant } from "../helpers/fixtures.js";

describe("statement CSV amounts in each currency's minor unit", () => {
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

  async function csvRows(currency: CurrencyCode, funded: string, paid: string): Promise<string[][]> {
    t.clock.set("2030-01-20T08:00:00.000Z");
    const wallet = await fundedWallet(t.app, tenant, funded, currency);
    const merchant = await openAccount(t.app, tenant, { currency });
    t.clock.set("2030-02-03T12:00:00.000Z");
    await transfer(t.app, tenant, wallet.id, merchant.id, paid, currency);
    const response = await t.app.inject({
      method: "GET",
      url: `/accounts/${wallet.id}/statement?from=2030-02-01&to=2030-02-28&format=csv`,
      headers: tenant.headers,
    });
    expect(response.statusCode).toBe(200);
    const [, ...rows] = response.body.trimEnd().split("\r\n");
    return rows.map((row) => row.split(","));
  }

  it("writes yen without decimals", async () => {
    const rows = await csvRows("JPY", "1500", "250");
    expect(rows.map((row) => [row[0], row[4], row[5], row[6]])).toEqual([
      ["opening", "", "1500", "JPY"],
      ["entry", "-250", "1250", "JPY"],
      ["closing", "", "1250", "JPY"],
    ]);
  });

  it("writes dinars with three decimals", async () => {
    const rows = await csvRows("KWD", "10005", "1005");
    expect(rows.map((row) => [row[0], row[4], row[5], row[6]])).toEqual([
      ["opening", "", "10.005", "KWD"],
      ["entry", "-1.005", "9.000", "KWD"],
      ["closing", "", "9.000", "KWD"],
    ]);
  });
});
