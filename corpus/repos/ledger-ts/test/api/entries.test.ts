import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildTestApp, type TestApp } from "../helpers/app.js";
import {
  createTenant,
  fundedWallet,
  issueKey,
  openAccount,
  transfer,
  type EntryBody,
  type TestTenant,
} from "../helpers/fixtures.js";

interface EntryPage {
  data: EntryBody[];
  pagination: { limit: number; offset: number; has_more: boolean };
}

describe("account entries", () => {
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

  it("lists an account's entries newest first with running balances", async () => {
    const wallet = await fundedWallet(t.app, tenant, "1000");
    const merchant = await openAccount(t.app, tenant);
    t.clock.advanceSeconds(1);
    const first = await transfer(t.app, tenant, wallet.id, merchant.id, "100");
    t.clock.advanceSeconds(1);
    const second = await transfer(t.app, tenant, merchant.id, wallet.id, "40");

    const response = await t.app.inject({
      method: "GET",
      url: `/accounts/${wallet.id}/entries`,
      headers: tenant.headers,
    });
    expect(response.statusCode).toBe(200);
    const entries = response.json<EntryPage>().data;
    expect(entries.map((e) => [e.transfer_id, e.amount, e.balance_after])).toEqual([
      [second.id, "40", "940"],
      [first.id, "-100", "900"],
      [expect.any(String), "1000", "1000"],
    ]);
  });

  it("pages through entries that share a timestamp without gaps or repeats", async () => {
    const wallet = await fundedWallet(t.app, tenant, "1000");
    const merchant = await openAccount(t.app, tenant);
    for (let i = 0; i < 4; i++) {
      await transfer(t.app, tenant, wallet.id, merchant.id, "10");
    }
    const seen: string[] = [];
    for (let offset = 0; offset < 6; offset += 2) {
      const response = await t.app.inject({
        method: "GET",
        url: `/accounts/${wallet.id}/entries?limit=2&offset=${offset}`,
        headers: tenant.headers,
      });
      seen.push(...response.json<EntryPage>().data.map((e) => e.id));
    }
    expect(seen).toHaveLength(5);
    expect(new Set(seen).size).toBe(5);
  });

  it("needs the transfers:read scope", async () => {
    const wallet = await openAccount(t.app, tenant);
    const accountsOnly = await issueKey(t.pool, t.clock, tenant.tenantId, ["accounts:read"]);
    const response = await t.app.inject({
      method: "GET",
      url: `/accounts/${wallet.id}/entries`,
      headers: accountsOnly.headers,
    });
    expect(response.statusCode).toBe(403);
  });

  it("answers 404 for another tenant's account", async () => {
    const wallet = await fundedWallet(t.app, tenant, "1000");
    const other = await createTenant(t.pool, t.clock, { name: "Other" });
    const response = await t.app.inject({
      method: "GET",
      url: `/accounts/${wallet.id}/entries`,
      headers: other.headers,
    });
    expect(response.statusCode).toBe(404);
  });
});
