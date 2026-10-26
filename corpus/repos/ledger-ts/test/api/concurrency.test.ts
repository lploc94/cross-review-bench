import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildTestApp, type TestApp } from "../helpers/app.js";
import {
  createHold,
  createTenant,
  fundedWallet,
  getAccount,
  openAccount,
  transferRequest,
  type HoldBody,
  type TestTenant,
  type TransferBody,
} from "../helpers/fixtures.js";

describe("concurrent requests", () => {
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

  it("never overdraw a wallet", async () => {
    const wallet = await fundedWallet(t.app, tenant, "500");
    const merchant = await openAccount(t.app, tenant);
    const responses = await Promise.all(
      Array.from({ length: 8 }, () =>
        transferRequest(t.app, tenant, {
          from_account_id: wallet.id,
          to_account_id: merchant.id,
          amount: "100",
          currency: "USD",
        }),
      ),
    );
    const statuses = responses.map((r) => r.statusCode).sort();
    expect(statuses).toEqual([201, 201, 201, 201, 201, 422, 422, 422]);
    expect((await getAccount(t.app, tenant, wallet.id)).balance).toBe("0");
    expect((await getAccount(t.app, tenant, merchant.id)).balance).toBe("500");
  });

  it("post a transfer once for parallel requests with one idempotency key", async () => {
    const wallet = await fundedWallet(t.app, tenant, "500");
    const merchant = await openAccount(t.app, tenant);
    const key = randomUUID();
    const body = { from_account_id: wallet.id, to_account_id: merchant.id, amount: "100", currency: "USD" };
    const responses = await Promise.all(Array.from({ length: 5 }, () => transferRequest(t.app, tenant, body, key)));

    expect(responses.map((r) => r.statusCode)).toEqual([201, 201, 201, 201, 201]);
    expect(new Set(responses.map((r) => r.json<TransferBody>().id)).size).toBe(1);
    expect(responses.filter((r) => r.headers["idempotent-replayed"] === "false")).toHaveLength(1);
    expect((await getAccount(t.app, tenant, wallet.id)).balance).toBe("400");
  });

  it("do not deadlock on transfers in opposite directions", async () => {
    const a = await fundedWallet(t.app, tenant, "1000");
    const b = await fundedWallet(t.app, tenant, "1000");
    const requests = Array.from({ length: 10 }, (_, i) =>
      transferRequest(t.app, tenant, {
        from_account_id: i % 2 === 0 ? a.id : b.id,
        to_account_id: i % 2 === 0 ? b.id : a.id,
        amount: "10",
        currency: "USD",
      }),
    );
    const responses = await Promise.all(requests);
    expect(responses.every((r) => r.statusCode === 201)).toBe(true);
    expect((await getAccount(t.app, tenant, a.id)).balance).toBe("1000");
    expect((await getAccount(t.app, tenant, b.id)).balance).toBe("1000");
  });

  it("let exactly one of a capture and a void win", async () => {
    const wallet = await fundedWallet(t.app, tenant, "1000");
    const merchant = await openAccount(t.app, tenant);
    for (let round = 0; round < 5; round++) {
      const hold = (await createHold(t.app, tenant, { account_id: wallet.id, amount: "100" })).json<HoldBody>();
      const [captured, voided] = await Promise.all([
        t.app.inject({
          method: "POST",
          url: `/holds/${hold.id}/capture`,
          headers: tenant.headers,
          payload: { to_account_id: merchant.id },
        }),
        t.app.inject({ method: "POST", url: `/holds/${hold.id}/void`, headers: tenant.headers }),
      ]);
      expect([captured.statusCode, voided.statusCode].sort()).toEqual([200, 409]);
    }
    const account = await getAccount(t.app, tenant, wallet.id);
    const moved = BigInt((await getAccount(t.app, tenant, merchant.id)).balance);
    expect(account.held).toBe("0");
    expect(BigInt(account.balance) + moved).toBe(1000n);
  });
});
