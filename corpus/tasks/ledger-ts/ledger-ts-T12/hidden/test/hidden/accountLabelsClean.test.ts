import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildTestApp, type TestApp } from "../helpers/app.js";
import {
  createTenant,
  fundedWallet,
  getAccount,
  openAccount,
  transfer,
  type AccountBody,
  type TestTenant,
} from "../helpers/fixtures.js";

interface AccountPage {
  data: AccountBody[];
  pagination: { limit: number; offset: number; has_more: boolean };
}

describe("account labels (behaviour)", () => {
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

  async function setLabels(key: TestTenant, id: string, labels: Record<string, string>) {
    const response = await t.app.inject({
      method: "PATCH",
      url: `/accounts/${id}`,
      headers: key.headers,
      payload: { labels },
    });
    expect(response.statusCode, response.body).toBe(200);
    return response.json<AccountBody>();
  }

  async function list(key: TestTenant, query: string): Promise<AccountPage> {
    const response = await t.app.inject({ method: "GET", url: `/accounts?${query}`, headers: key.headers });
    expect(response.statusCode, response.body).toBe(200);
    return response.json<AccountPage>();
  }

  it("never lists another tenant's accounts through a label filter", async () => {
    const other = await createTenant(t.pool, t.clock, { name: "Other" });
    const theirs = await openAccount(t.app, other);
    await setLabels(other, theirs.id, { team: "hr" });
    const mine = await openAccount(t.app, tenant);
    await setLabels(tenant, mine.id, { team: "hr" });

    expect((await list(tenant, "label=team:hr")).data.map((a) => a.id)).toEqual([mine.id]);
    expect((await list(other, "label=team:hr")).data.map((a) => a.id)).toEqual([theirs.id]);
  });

  it("pages through a filtered list newest first", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const account = await openAccount(t.app, tenant, { name: `a${i}` });
      if (i !== 2) await setLabels(tenant, account.id, { group: "x" });
      ids.push(account.id);
      t.clock.advanceSeconds(1);
    }
    const first = await list(tenant, "label=group:x&limit=2");
    expect(first.data.map((a) => a.id)).toEqual([ids[4], ids[3]]);
    expect(first.pagination.has_more).toBe(true);
    const second = await list(tenant, "label=group:x&limit=2&offset=2");
    expect(second.data.map((a) => a.id)).toEqual([ids[1], ids[0]]);
    expect(second.pagination.has_more).toBe(false);
  });

  it("keeps balances untouched and works on closed accounts", async () => {
    const wallet = await fundedWallet(t.app, tenant, "1000");
    const merchant = await openAccount(t.app, tenant);
    await transfer(t.app, tenant, wallet.id, merchant.id, "300");
    const labelled = await setLabels(tenant, wallet.id, { tier: "gold" });
    expect(labelled).toMatchObject({ balance: "700", held: "0", available: "700", status: "open" });

    const empty = await openAccount(t.app, tenant);
    const closed = await t.app.inject({ method: "POST", url: `/accounts/${empty.id}/close`, headers: tenant.headers });
    expect(closed.statusCode).toBe(200);
    expect(await setLabels(tenant, empty.id, { archived: "2030" })).toMatchObject({
      status: "closed",
      labels: { archived: "2030" },
    });
    expect((await getAccount(t.app, tenant, empty.id)).labels).toEqual({ archived: "2030" });
  });

  it("treats label values literally", async () => {
    const account = await openAccount(t.app, tenant);
    await setLabels(tenant, account.id, { note: "50% off, 'quoted' \"too\"", path: "a/b?c=d" });
    const query = new URLSearchParams([
      ["label", "note:50% off, 'quoted' \"too\""],
      ["label", "path:a/b?c=d"],
    ]).toString();
    expect((await list(tenant, query)).data.map((a) => a.id)).toEqual([account.id]);
    expect((await list(tenant, "label=note:50%25")).data).toEqual([]);
  });
});
