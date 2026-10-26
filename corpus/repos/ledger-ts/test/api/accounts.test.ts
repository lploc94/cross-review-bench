import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildTestApp, type TestApp } from "../helpers/app.js";
import {
  createTenant,
  fundedWallet,
  getAccount,
  openAccount,
  transfer,
  transferRequest,
  type AccountBody,
  type ErrorResponse,
  type TestTenant,
} from "../helpers/fixtures.js";

interface AccountPage {
  data: AccountBody[];
  pagination: { limit: number; offset: number; has_more: boolean };
}

describe("accounts", () => {
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

  it("opens an empty wallet by default", async () => {
    const response = await t.app.inject({
      method: "POST",
      url: "/accounts",
      headers: tenant.headers,
      payload: { name: "  Alice  ", currency: "EUR" },
    });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      name: "Alice",
      currency: "EUR",
      kind: "wallet",
      status: "open",
      balance: "0",
      held: "0",
      available: "0",
      created_at: t.clock.now().toISOString(),
    });
  });

  it("validates the request body", async () => {
    const bodies = [
      { name: "x", currency: "XYZ" },
      { name: "", currency: "USD" },
      { name: "x", currency: "USD", kind: "savings" },
      { name: "x", currency: "USD", balance: "100" },
    ];
    for (const payload of bodies) {
      const response = await t.app.inject({ method: "POST", url: "/accounts", headers: tenant.headers, payload });
      expect(response.statusCode).toBe(400);
      expect(response.json<ErrorResponse>().error.code).toBe("validation_error");
    }
  });

  it("rejects names Postgres cannot store", async () => {
    for (const name of ["Pay\u0000roll", "Lone \ud800", "\udc00 Ops", "Ops \ud83d"]) {
      const response = await t.app.inject({
        method: "POST",
        url: "/accounts",
        headers: tenant.headers,
        payload: { name, currency: "USD" },
      });
      expect(response.statusCode, JSON.stringify(name)).toBe(400);
      expect(response.json<ErrorResponse>().error).toMatchObject({
        code: "validation_error",
        details: [{ path: "body.name", message: "must not contain NUL characters or unpaired surrogates" }],
      });
    }
    const emoji = await t.app.inject({
      method: "POST",
      url: "/accounts",
      headers: tenant.headers,
      payload: { name: "Ops 😀", currency: "USD" },
    });
    expect(emoji.statusCode).toBe(201);
    expect(emoji.json<AccountBody>().name).toBe("Ops 😀");
  });

  it("reads an account by id in any letter case", async () => {
    const account = await openAccount(t.app, tenant);
    const response = await t.app.inject({
      method: "GET",
      url: `/accounts/${account.id.toUpperCase()}`,
      headers: tenant.headers,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json<AccountBody>().id).toBe(account.id);
  });

  it("answers 404 for unknown ids and 400 for malformed ones", async () => {
    const unknown = await t.app.inject({
      method: "GET",
      url: "/accounts/0b6d7f5e-0000-4000-8000-000000000000",
      headers: tenant.headers,
    });
    expect(unknown.statusCode).toBe(404);
    const malformed = await t.app.inject({ method: "GET", url: "/accounts/not-a-uuid", headers: tenant.headers });
    expect(malformed.statusCode).toBe(400);
  });

  it("lists accounts newest first with offset pagination", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      ids.push((await openAccount(t.app, tenant, { name: `account ${i}` })).id);
      t.clock.advanceSeconds(1);
    }
    const first = await t.app.inject({ method: "GET", url: "/accounts?limit=2", headers: tenant.headers });
    const page1 = first.json<AccountPage>();
    expect(page1.data.map((a) => a.id)).toEqual([ids[4], ids[3]]);
    expect(page1.pagination).toEqual({ limit: 2, offset: 0, has_more: true });

    const last = await t.app.inject({ method: "GET", url: "/accounts?limit=2&offset=4", headers: tenant.headers });
    const page3 = last.json<AccountPage>();
    expect(page3.data.map((a) => a.id)).toEqual([ids[0]]);
    expect(page3.pagination.has_more).toBe(false);
  });

  it("rejects out-of-range pagination parameters", async () => {
    for (const query of ["limit=0", "limit=101", "limit=abc", "offset=-1", "limit="]) {
      const response = await t.app.inject({ method: "GET", url: `/accounts?${query}`, headers: tenant.headers });
      expect(response.statusCode, query).toBe(400);
    }
  });

  it("only lists the caller's accounts", async () => {
    const other = await createTenant(t.pool, t.clock, { name: "Other" });
    await openAccount(t.app, other);
    const mine = await openAccount(t.app, tenant);
    const response = await t.app.inject({ method: "GET", url: "/accounts", headers: tenant.headers });
    expect(response.json<AccountPage>().data.map((a) => a.id)).toEqual([mine.id]);
  });

  it("closes an empty account, after which it takes no transfers", async () => {
    const funding = await openAccount(t.app, tenant, { kind: "system" });
    const account = await openAccount(t.app, tenant);
    const closed = await t.app.inject({ method: "POST", url: `/accounts/${account.id}/close`, headers: tenant.headers });
    expect(closed.statusCode).toBe(200);
    expect(closed.json<AccountBody>().status).toBe("closed");

    const response = await transferRequest(t.app, tenant, {
      from_account_id: funding.id,
      to_account_id: account.id,
      amount: "100",
      currency: "USD",
    });
    expect(response.statusCode).toBe(422);
    expect(response.json<ErrorResponse>().error.code).toBe("account_closed");
  });

  it("refuses to close an account that still holds funds", async () => {
    const wallet = await fundedWallet(t.app, tenant, "500");
    const response = await t.app.inject({ method: "POST", url: `/accounts/${wallet.id}/close`, headers: tenant.headers });
    expect(response.statusCode).toBe(409);
    expect((await getAccount(t.app, tenant, wallet.id)).status).toBe("open");
  });

  it("reports balance, held and available amounts", async () => {
    const wallet = await fundedWallet(t.app, tenant, "1000");
    const merchant = await openAccount(t.app, tenant);
    await transfer(t.app, tenant, wallet.id, merchant.id, "250");
    const hold = await t.app.inject({
      method: "POST",
      url: "/holds",
      headers: tenant.headers,
      payload: { account_id: wallet.id, amount: "300", currency: "USD", expires_in_seconds: 600 },
    });
    expect(hold.statusCode).toBe(201);
    expect(await getAccount(t.app, tenant, wallet.id)).toMatchObject({
      balance: "750",
      held: "300",
      available: "450",
    });
  });
});
