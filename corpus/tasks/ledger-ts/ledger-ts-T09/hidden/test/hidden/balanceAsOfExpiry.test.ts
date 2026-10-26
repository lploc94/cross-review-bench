import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildTestApp, type TestApp } from "../helpers/app.js";
import { createTenant, fundedWallet, getAccount, type TestTenant } from "../helpers/fixtures.js";

describe("Redis keys written by the balance cache", () => {
  let t: TestApp;
  let tenant: TestTenant;

  beforeAll(async () => {
    t = await buildTestApp({ env: { BALANCE_CACHE_TTL_S: "300" } });
  });

  afterAll(async () => {
    await t.close();
  });

  beforeEach(async () => {
    tenant = await createTenant(t.pool, t.clock);
  });

  it("all expire, including balances cached for an as_of instant", async () => {
    const wallet = await fundedWallet(t.app, tenant, "1000");
    await getAccount(t.app, tenant, wallet.id);
    t.clock.advanceSeconds(2 * 3600);

    for (const asOf of ["2030-01-15T11:00:00.000Z", "2030-01-15T10:30:00.000Z", "2030-01-15T10:00:00.250Z"]) {
      const response = await t.app.inject({
        method: "GET",
        url: `/accounts/${wallet.id}/balance?as_of=${encodeURIComponent(asOf)}`,
        headers: tenant.headers,
      });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json<{ balance: string }>().balance).toBe("1000");
    }

    const keys = await t.redis.keys("*");
    const balanceKeys = keys.filter((key) => key.includes(wallet.id));
    expect(balanceKeys.length).toBeGreaterThan(1);
    for (const key of keys) {
      expect(await t.redis.pttl(key), key).toBeGreaterThan(0);
    }
  });
});
