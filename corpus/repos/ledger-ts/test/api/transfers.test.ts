import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildTestApp, type TestApp } from "../helpers/app.js";
import {
  createTenant,
  fundedWallet,
  getAccount,
  openAccount,
  transfer,
  transferRequest,
  type ErrorResponse,
  type TestTenant,
  type TransferBody,
} from "../helpers/fixtures.js";

interface TransferPage {
  data: TransferBody[];
  pagination: { limit: number; offset: number; has_more: boolean };
}

describe("transfers", () => {
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

  async function transferCount(): Promise<number> {
    const result = await t.pool.query<{ count: string }>("SELECT count(*) AS count FROM transfers");
    return Number(result.rows[0]?.count);
  }

  it("moves funds and writes balanced entries", async () => {
    const wallet = await fundedWallet(t.app, tenant, "1000");
    const merchant = await openAccount(t.app, tenant);

    const response = await transferRequest(t.app, tenant, {
      from_account_id: wallet.id,
      to_account_id: merchant.id,
      amount: "275",
      currency: "USD",
      description: "Order 1001",
      metadata: { order_id: "1001" },
    });
    expect(response.statusCode).toBe(201);
    expect(response.headers["idempotent-replayed"]).toBe("false");
    const body = response.json<TransferBody>();
    expect(body).toMatchObject({
      from_account_id: wallet.id,
      to_account_id: merchant.id,
      amount: "275",
      currency: "USD",
      description: "Order 1001",
      metadata: { order_id: "1001" },
      status: "posted",
    });
    expect(body.entries).toEqual([
      expect.objectContaining({ account_id: wallet.id, amount: "-275", balance_after: "725" }),
      expect.objectContaining({ account_id: merchant.id, amount: "275", balance_after: "275" }),
    ]);
    expect((await getAccount(t.app, tenant, wallet.id)).balance).toBe("725");
    expect((await getAccount(t.app, tenant, merchant.id)).balance).toBe("275");

    const sums = await t.pool.query<{ total: string }>(
      "SELECT sum(amount_minor)::text AS total FROM entries GROUP BY transfer_id",
    );
    expect(sums.rows.every((row) => row.total === "0")).toBe(true);
  });

  it("requires an Idempotency-Key header", async () => {
    const wallet = await fundedWallet(t.app, tenant, "100");
    const merchant = await openAccount(t.app, tenant);
    const response = await t.app.inject({
      method: "POST",
      url: "/transfers",
      headers: tenant.headers,
      payload: { from_account_id: wallet.id, to_account_id: merchant.id, amount: "1", currency: "USD" },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json<ErrorResponse>().error.code).toBe("validation_error");
  });

  it("replays the stored response for a retried request", async () => {
    const wallet = await fundedWallet(t.app, tenant, "1000");
    const merchant = await openAccount(t.app, tenant);
    const body = { from_account_id: wallet.id, to_account_id: merchant.id, amount: "100", currency: "USD" };
    const key = randomUUID();
    const before = await transferCount();

    const first = await transferRequest(t.app, tenant, body, key);
    t.clock.advanceSeconds(30);
    const retry = await transferRequest(t.app, tenant, { ...body }, key);

    expect(retry.statusCode).toBe(201);
    expect(retry.headers["idempotent-replayed"]).toBe("true");
    expect(retry.json()).toEqual(first.json());
    expect(await transferCount()).toBe(before + 1);
    expect((await getAccount(t.app, tenant, wallet.id)).balance).toBe("900");
  });

  it("refuses to reuse a key for a different request", async () => {
    const wallet = await fundedWallet(t.app, tenant, "1000");
    const merchant = await openAccount(t.app, tenant);
    const key = randomUUID();
    const body = { from_account_id: wallet.id, to_account_id: merchant.id, amount: "100", currency: "USD" };
    expect((await transferRequest(t.app, tenant, body, key)).statusCode).toBe(201);

    const conflict = await transferRequest(t.app, tenant, { ...body, amount: "101" }, key);
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json<ErrorResponse>().error.code).toBe("idempotency_conflict");
  });

  it("scopes idempotency keys by tenant", async () => {
    const other = await createTenant(t.pool, t.clock, { name: "Other" });
    const key = "order-1001";
    for (const owner of [tenant, other]) {
      const wallet = await fundedWallet(t.app, owner, "100");
      const merchant = await openAccount(t.app, owner);
      const response = await transferRequest(
        t.app,
        owner,
        { from_account_id: wallet.id, to_account_id: merchant.id, amount: "100", currency: "USD" },
        key,
      );
      expect(response.statusCode).toBe(201);
      expect(response.headers["idempotent-replayed"]).toBe("false");
    }
  });

  it("does not keep the key of a request that failed", async () => {
    const wallet = await fundedWallet(t.app, tenant, "50");
    const merchant = await openAccount(t.app, tenant);
    const funding = await openAccount(t.app, tenant, { kind: "system" });
    const key = randomUUID();
    const body = { from_account_id: wallet.id, to_account_id: merchant.id, amount: "80", currency: "USD" };

    const refused = await transferRequest(t.app, tenant, body, key);
    expect(refused.statusCode).toBe(422);
    await transfer(t.app, tenant, funding.id, wallet.id, "30");

    const retried = await transferRequest(t.app, tenant, body, key);
    expect(retried.statusCode).toBe(201);
    expect((await getAccount(t.app, tenant, wallet.id)).balance).toBe("0");
  });

  it("refuses to overdraw a wallet", async () => {
    const wallet = await fundedWallet(t.app, tenant, "100");
    const merchant = await openAccount(t.app, tenant);
    const response = await transferRequest(t.app, tenant, {
      from_account_id: wallet.id,
      to_account_id: merchant.id,
      amount: "101",
      currency: "USD",
    });
    expect(response.statusCode).toBe(422);
    expect(response.json<ErrorResponse>().error).toMatchObject({
      code: "insufficient_funds",
      details: { available: "100", requested: "101" },
    });
    expect((await getAccount(t.app, tenant, wallet.id)).balance).toBe("100");
  });

  it("lets system accounts go below zero", async () => {
    const funding = await openAccount(t.app, tenant, { kind: "system" });
    const wallet = await openAccount(t.app, tenant);
    await transfer(t.app, tenant, funding.id, wallet.id, "5000");
    expect((await getAccount(t.app, tenant, funding.id)).balance).toBe("-5000");
  });

  it("requires the accounts and the transfer to share one currency", async () => {
    const wallet = await fundedWallet(t.app, tenant, "1000", "EUR");
    const usd = await openAccount(t.app, tenant, { currency: "USD" });
    const eur = await openAccount(t.app, tenant, { currency: "EUR" });

    const wrongAccount = await transferRequest(t.app, tenant, {
      from_account_id: wallet.id,
      to_account_id: usd.id,
      amount: "100",
      currency: "EUR",
    });
    expect(wrongAccount.statusCode).toBe(422);
    expect(wrongAccount.json<ErrorResponse>().error.code).toBe("currency_mismatch");

    const wrongCurrency = await transferRequest(t.app, tenant, {
      from_account_id: wallet.id,
      to_account_id: eur.id,
      amount: "100",
      currency: "USD",
    });
    expect(wrongCurrency.statusCode).toBe(422);
  });

  it("validates the request body", async () => {
    const wallet = await fundedWallet(t.app, tenant, "1000");
    const merchant = await openAccount(t.app, tenant);
    const base = { from_account_id: wallet.id, to_account_id: merchant.id, amount: "100", currency: "USD" };
    const invalid = [
      { ...base, amount: "0" },
      { ...base, amount: "-5" },
      { ...base, amount: "1.50" },
      { ...base, amount: 100 },
      { ...base, amount: "0100" },
      { ...base, to_account_id: wallet.id },
      { ...base, currency: "usd" },
      { ...base, metadata: { nested: { a: 1 } } },
    ];
    for (const body of invalid) {
      const response = await transferRequest(t.app, tenant, body);
      expect(response.statusCode, JSON.stringify(body)).toBe(400);
    }
  });

  it("answers 404 when an account does not exist", async () => {
    const wallet = await fundedWallet(t.app, tenant, "1000");
    const response = await transferRequest(t.app, tenant, {
      from_account_id: wallet.id,
      to_account_id: randomUUID(),
      amount: "100",
      currency: "USD",
    });
    expect(response.statusCode).toBe(404);
  });

  it("reads a transfer with its entries", async () => {
    const wallet = await fundedWallet(t.app, tenant, "1000");
    const merchant = await openAccount(t.app, tenant);
    const posted = await transfer(t.app, tenant, wallet.id, merchant.id, "10");

    const response = await t.app.inject({ method: "GET", url: `/transfers/${posted.id}`, headers: tenant.headers });
    expect(response.statusCode).toBe(200);
    expect(response.json<TransferBody>()).toEqual(posted);

    const other = await createTenant(t.pool, t.clock, { name: "Other" });
    const foreign = await t.app.inject({ method: "GET", url: `/transfers/${posted.id}`, headers: other.headers });
    expect(foreign.statusCode).toBe(404);
  });

  it("filters the list by account", async () => {
    const wallet = await fundedWallet(t.app, tenant, "1000");
    const a = await openAccount(t.app, tenant);
    const b = await openAccount(t.app, tenant);
    const toA = await transfer(t.app, tenant, wallet.id, a.id, "10");
    t.clock.advanceSeconds(1);
    const toB = await transfer(t.app, tenant, wallet.id, b.id, "20");
    t.clock.advanceSeconds(1);
    const aToB = await transfer(t.app, tenant, a.id, b.id, "5");

    const response = await t.app.inject({ method: "GET", url: `/transfers?account_id=${b.id}`, headers: tenant.headers });
    expect(response.json<TransferPage>().data.map((x) => x.id)).toEqual([aToB.id, toB.id]);

    const forA = await t.app.inject({ method: "GET", url: `/transfers?account_id=${a.id}`, headers: tenant.headers });
    expect(forA.json<TransferPage>().data.map((x) => x.id)).toEqual([aToB.id, toA.id]);
  });

  it("filters by a creation range that includes created_from and excludes created_to", async () => {
    const wallet = await fundedWallet(t.app, tenant, "1000");
    const merchant = await openAccount(t.app, tenant);
    t.clock.set("2030-02-01T09:00:00.000Z");
    const nine = await transfer(t.app, tenant, wallet.id, merchant.id, "1");
    t.clock.set("2030-02-01T10:00:00.000Z");
    const ten = await transfer(t.app, tenant, wallet.id, merchant.id, "2");
    t.clock.set("2030-02-01T11:00:00.000Z");
    await transfer(t.app, tenant, wallet.id, merchant.id, "3");

    const response = await t.app.inject({
      method: "GET",
      url: "/transfers?created_from=2030-02-01T09:00:00Z&created_to=2030-02-01T11:00:00Z",
      headers: tenant.headers,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json<TransferPage>().data.map((x) => x.id)).toEqual([ten.id, nine.id]);
  });

  it("rejects an empty or inverted creation range", async () => {
    for (const query of [
      "created_from=2030-02-01T10:00:00Z&created_to=2030-02-01T10:00:00Z",
      "created_from=2030-02-01T11:00:00Z&created_to=2030-02-01T10:00:00Z",
      "created_from=yesterday",
      "created_to=2030-02-01T10:00:00",
    ]) {
      const response = await t.app.inject({ method: "GET", url: `/transfers?${query}`, headers: tenant.headers });
      expect(response.statusCode, query).toBe(400);
    }
  });

  it("writes a transfer.posted event to the outbox", async () => {
    const wallet = await fundedWallet(t.app, tenant, "1000");
    const merchant = await openAccount(t.app, tenant);
    const posted = await transfer(t.app, tenant, wallet.id, merchant.id, "10");
    const events = await t.pool.query<{ event_type: string; payload: { transfer: { amount: string } } }>(
      "SELECT event_type, payload FROM outbox WHERE aggregate_id = $1",
      [posted.id],
    );
    expect(events.rows).toHaveLength(1);
    expect(events.rows[0]).toMatchObject({
      event_type: "transfer.posted",
      payload: { transfer: { id: posted.id, amount: "10" } },
    });
  });
});
