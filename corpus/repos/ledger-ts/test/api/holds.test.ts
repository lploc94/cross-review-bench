import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildTestApp, type TestApp } from "../helpers/app.js";
import {
  createHold,
  createTenant,
  fundedWallet,
  getAccount,
  issueKey,
  openAccount,
  type AccountBody,
  type ErrorResponse,
  type HoldBody,
  type TestTenant,
  type TransferBody,
} from "../helpers/fixtures.js";

describe("holds", () => {
  let t: TestApp;
  let tenant: TestTenant;
  let wallet: AccountBody;
  let merchant: AccountBody;

  beforeAll(async () => {
    t = await buildTestApp();
  });

  afterAll(async () => {
    await t.close();
  });

  beforeEach(async () => {
    tenant = await createTenant(t.pool, t.clock);
    wallet = await fundedWallet(t.app, tenant, "1000");
    merchant = await openAccount(t.app, tenant);
  });

  async function hold(amount: string, expiresInSeconds = 3600): Promise<HoldBody> {
    const response = await createHold(t.app, tenant, {
      account_id: wallet.id,
      amount,
      expires_in_seconds: expiresInSeconds,
    });
    expect(response.statusCode).toBe(201);
    return response.json<HoldBody>();
  }

  function capture(id: string, toAccountId: string = merchant.id) {
    return t.app.inject({
      method: "POST",
      url: `/holds/${id}/capture`,
      headers: tenant.headers,
      payload: { to_account_id: toAccountId },
    });
  }

  function voidHold(id: string) {
    return t.app.inject({ method: "POST", url: `/holds/${id}/void`, headers: tenant.headers });
  }

  it("reserves funds without moving them", async () => {
    const created = await hold("400", 600);
    expect(created).toMatchObject({
      account_id: wallet.id,
      amount: "400",
      status: "active",
      expires_at: new Date(t.clock.now().getTime() + 600_000).toISOString(),
      captured_transfer_id: null,
    });
    expect(await getAccount(t.app, tenant, wallet.id)).toMatchObject({
      balance: "1000",
      held: "400",
      available: "600",
    });
  });

  it("cannot reserve more than is available", async () => {
    await hold("700");
    const response = await createHold(t.app, tenant, { account_id: wallet.id, amount: "301" });
    expect(response.statusCode).toBe(422);
    expect(response.json<ErrorResponse>().error.code).toBe("insufficient_funds");
  });

  it("validates the expiry window", async () => {
    for (const seconds of [59, 604_801, 1.5]) {
      const response = await createHold(t.app, tenant, {
        account_id: wallet.id,
        amount: "1",
        expires_in_seconds: seconds,
      });
      expect(response.statusCode, String(seconds)).toBe(400);
    }
    expect((await createHold(t.app, tenant, { account_id: wallet.id, amount: "1", expires_in_seconds: 60 })).statusCode).toBe(201);
    expect((await createHold(t.app, tenant, { account_id: wallet.id, amount: "1", expires_in_seconds: 604_800 })).statusCode).toBe(201);
  });

  it("captures the full amount into another account", async () => {
    const created = await hold("400");
    const response = await capture(created.id);
    expect(response.statusCode).toBe(200);
    const { hold: captured, transfer } = response.json<{ hold: HoldBody; transfer: TransferBody }>();
    expect(captured.status).toBe("captured");
    expect(captured.captured_transfer_id).toBe(transfer.id);
    expect(transfer).toMatchObject({
      from_account_id: wallet.id,
      to_account_id: merchant.id,
      amount: "400",
      metadata: { hold_id: created.id },
    });
    expect(await getAccount(t.app, tenant, wallet.id)).toMatchObject({ balance: "600", held: "0", available: "600" });
    expect((await getAccount(t.app, tenant, merchant.id)).balance).toBe("400");
  });

  it("captures until one moment before expires_at and not from expires_at on", async () => {
    const early = await hold("100", 60);
    const late = await hold("100", 60);
    t.clock.advance(59_999);
    expect((await capture(early.id)).statusCode).toBe(200);

    t.clock.advance(1);
    const response = await capture(late.id);
    expect(response.statusCode).toBe(409);
    expect(response.json<ErrorResponse>().error.code).toBe("invalid_hold_state");
    expect((await getAccount(t.app, tenant, wallet.id)).held).toBe("100");
  });

  it("captures a hold only once", async () => {
    const created = await hold("100");
    expect((await capture(created.id)).statusCode).toBe(200);
    const again = await capture(created.id);
    expect(again.statusCode).toBe(409);
    expect((await getAccount(t.app, tenant, merchant.id)).balance).toBe("100");
  });

  it("leaves the hold active when the capture is refused", async () => {
    const created = await hold("100");
    const euro = await openAccount(t.app, tenant, { currency: "EUR" });
    const response = await capture(created.id, euro.id);
    expect(response.statusCode).toBe(422);

    const reread = await t.app.inject({ method: "GET", url: `/holds/${created.id}`, headers: tenant.headers });
    expect(reread.json<HoldBody>().status).toBe("active");
    expect((await getAccount(t.app, tenant, wallet.id)).held).toBe("100");
  });

  it("refuses to capture into the held account or an unknown one", async () => {
    const created = await hold("100");
    expect((await capture(created.id, wallet.id)).statusCode).toBe(400);
    expect((await capture(created.id, randomUUID())).statusCode).toBe(404);
  });

  it("voids a hold and releases its funds, expired or not", async () => {
    const current = await hold("100", 60);
    const expired = await hold("200", 60);
    const voided = await voidHold(current.id);
    expect(voided.statusCode).toBe(200);
    expect(voided.json<HoldBody>().status).toBe("voided");

    t.clock.advanceSeconds(120);
    expect((await voidHold(expired.id)).statusCode).toBe(200);
    expect(await getAccount(t.app, tenant, wallet.id)).toMatchObject({ held: "0", available: "1000" });
  });

  it("does not void a captured hold", async () => {
    const created = await hold("100");
    await capture(created.id);
    const response = await voidHold(created.id);
    expect(response.statusCode).toBe(409);
    expect((await getAccount(t.app, tenant, wallet.id)).held).toBe("0");
  });

  it("checks the holds scopes and hides other tenants' holds", async () => {
    const created = await hold("100");
    const reader = await issueKey(t.pool, t.clock, tenant.tenantId, ["holds:read"]);
    expect((await t.app.inject({ method: "GET", url: `/holds/${created.id}`, headers: reader.headers })).statusCode).toBe(200);
    expect(
      (await t.app.inject({ method: "POST", url: `/holds/${created.id}/void`, headers: reader.headers })).statusCode,
    ).toBe(403);

    const other = await createTenant(t.pool, t.clock, { name: "Other" });
    expect((await t.app.inject({ method: "GET", url: `/holds/${created.id}`, headers: other.headers })).statusCode).toBe(404);
    expect(
      (await t.app.inject({ method: "POST", url: `/holds/${created.id}/void`, headers: other.headers })).statusCode,
    ).toBe(404);
  });

  it("lists holds newest first, filtered by account, status and creation time", async () => {
    const first = await hold("100");
    t.clock.advanceSeconds(10);
    const second = await hold("200");
    t.clock.advanceSeconds(10);
    const third = await hold("300");
    await voidHold(second.id);
    const elsewhere = await fundedWallet(t.app, tenant, "500");
    await createHold(t.app, tenant, { account_id: elsewhere.id, amount: "50" });

    const list = async (query: string) => {
      const response = await t.app.inject({ method: "GET", url: `/holds?${query}`, headers: tenant.headers });
      expect(response.statusCode, query).toBe(200);
      return response.json<{ data: HoldBody[] }>().data.map((h) => h.id);
    };
    expect(await list(`account_id=${wallet.id}`)).toEqual([third.id, second.id, first.id]);
    expect(await list(`account_id=${wallet.id}&status=active`)).toEqual([third.id, first.id]);
    expect(await list(`account_id=${wallet.id}&created_to=${encodeURIComponent(third.created_at)}`)).toEqual([
      second.id,
      first.id,
    ]);
    expect(await list(`created_from=${encodeURIComponent(second.created_at)}&status=voided`)).toEqual([second.id]);

    const invalid = await t.app.inject({ method: "GET", url: "/holds?status=pending", headers: tenant.headers });
    expect(invalid.statusCode).toBe(400);
  });

  it("writes hold events to the outbox in order", async () => {
    const created = await hold("100");
    await capture(created.id);
    const events = await t.pool.query<{ event_type: string }>(
      "SELECT event_type FROM outbox WHERE aggregate_id = $1 ORDER BY id",
      [created.id],
    );
    expect(events.rows.map((row) => row.event_type)).toEqual(["hold.created", "hold.captured"]);
  });
});
