import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { verifySignature } from "../../src/services/webhookSigner.js";
import { buildTestApp, type TestApp } from "../helpers/app.js";
import {
  createHold,
  createTenant,
  fundedWallet,
  openAccount,
  transfer,
  type HoldBody,
  type TestTenant,
} from "../helpers/fixtures.js";

const ENDPOINT = "https://hooks.example.com/ledger";

interface OutboxRow {
  id: string;
  event_type: string;
  attempts: number;
  next_attempt_at: Date;
  delivered_at: Date | null;
  last_error: string | null;
}

describe("outbox dispatcher", () => {
  let t: TestApp;
  let tenant: TestTenant;
  let secret: string;

  beforeAll(async () => {
    t = await buildTestApp();
  });

  afterAll(async () => {
    await t.close();
  });

  beforeEach(async () => {
    t.sender.deliveries.length = 0;
    t.sender.attempts.length = 0;
    t.sender.recover(ENDPOINT);
    tenant = await createTenant(t.pool, t.clock);
    const created = await t.app.inject({
      method: "POST",
      url: "/webhooks",
      headers: tenant.headers,
      payload: { url: ENDPOINT },
    });
    secret = created.json<{ secret: string }>().secret;
  });

  async function outboxRows(): Promise<OutboxRow[]> {
    const result = await t.pool.query<OutboxRow>(
      "SELECT id, event_type, attempts, next_attempt_at, delivered_at, last_error FROM outbox ORDER BY id",
    );
    return result.rows;
  }

  it("delivers due events signed with the endpoint's secret and marks them delivered", async () => {
    const wallet = await fundedWallet(t.app, tenant, "1000");
    const merchant = await openAccount(t.app, tenant);
    const posted = await transfer(t.app, tenant, wallet.id, merchant.id, "250");

    const summary = await t.dispatcher.runOnce();
    expect(summary).toEqual({ claimed: 2, delivered: 2, failed: 0 });

    const delivery = t.sender.deliveries.find((d) => d.event.data && JSON.stringify(d.event.data).includes(posted.id));
    expect(delivery).toBeDefined();
    expect(delivery?.event.type).toBe("transfer.posted");
    expect(delivery?.headers["x-ledger-event-type"]).toBe("transfer.posted");
    const signature = delivery?.headers["x-ledger-signature"] ?? "";
    expect(verifySignature(secret, delivery?.body ?? "", signature, t.clock.now()).valid).toBe(true);

    expect((await outboxRows()).every((row) => row.delivered_at !== null)).toBe(true);
    expect(await t.dispatcher.runOnce()).toEqual({ claimed: 0, delivered: 0, failed: 0 });
  });

  it("records failures and retries with exponential backoff", async () => {
    const wallet = await fundedWallet(t.app, tenant, "1000");
    await t.dispatcher.runOnce();
    const merchant = await openAccount(t.app, tenant);
    await transfer(t.app, tenant, wallet.id, merchant.id, "10");
    t.sender.failFor(ENDPOINT);

    expect(await t.dispatcher.runOnce()).toMatchObject({ failed: 1 });
    let [, row] = await outboxRows();
    expect(row).toMatchObject({ attempts: 1, delivered_at: null, last_error: "endpoint answered HTTP 500" });
    expect(row?.next_attempt_at.getTime()).toBe(t.clock.now().getTime() + 1000);

    t.clock.advance(999);
    expect(await t.dispatcher.runOnce()).toMatchObject({ claimed: 0 });
    t.clock.advance(1);
    expect(await t.dispatcher.runOnce()).toMatchObject({ failed: 1 });
    [, row] = await outboxRows();
    expect(row?.attempts).toBe(2);
    expect(row?.next_attempt_at.getTime()).toBe(t.clock.now().getTime() + 2000);

    t.sender.recover(ENDPOINT);
    t.clock.advance(2000);
    expect(await t.dispatcher.runOnce()).toMatchObject({ delivered: 1 });
    [, row] = await outboxRows();
    expect(row).toMatchObject({ attempts: 3, last_error: null });
    expect(row?.delivered_at).not.toBeNull();
  });

  it("caps the backoff delay", () => {
    expect(t.dispatcher.backoffDelayMs(1)).toBe(1000);
    expect(t.dispatcher.backoffDelayMs(4)).toBe(8000);
    expect(t.dispatcher.backoffDelayMs(7)).toBe(60_000);
    expect(t.dispatcher.backoffDelayMs(500)).toBe(60_000);
  });

  it("holds back later events of an aggregate behind a failed one, but not other aggregates", async () => {
    const wallet = await fundedWallet(t.app, tenant, "1000");
    const merchant = await openAccount(t.app, tenant);
    await t.dispatcher.runOnce();

    const hold = (await createHold(t.app, tenant, { account_id: wallet.id, amount: "100" })).json<HoldBody>();
    t.sender.failFor(ENDPOINT);
    await t.dispatcher.runOnce();
    t.sender.recover(ENDPOINT);

    await t.app.inject({
      method: "POST",
      url: `/holds/${hold.id}/capture`,
      headers: tenant.headers,
      payload: { to_account_id: merchant.id },
    });
    t.sender.deliveries.length = 0;
    await t.dispatcher.runOnce();
    // The capture's transfer.posted belongs to another aggregate and goes out; hold.captured waits.
    expect(t.sender.eventTypes()).toEqual(["transfer.posted"]);

    t.clock.advanceSeconds(1);
    await t.dispatcher.runOnce();
    expect(t.sender.eventTypes()).toEqual(["transfer.posted", "hold.created"]);
    await t.dispatcher.runOnce();
    expect(t.sender.eventTypes()).toEqual(["transfer.posted", "hold.created", "hold.captured"]);
  });

  it("marks events delivered when the tenant has no active endpoint", async () => {
    const quiet = await createTenant(t.pool, t.clock, { name: "No webhooks" });
    await fundedWallet(t.app, quiet, "100");
    const summary = await t.dispatcher.runOnce();
    expect(summary).toEqual({ claimed: 1, delivered: 1, failed: 0 });
    expect(t.sender.attempts).toHaveLength(0);
  });

  it("never hands one event to two dispatchers running at once", async () => {
    const wallet = await fundedWallet(t.app, tenant, "1000");
    for (let i = 0; i < 6; i++) {
      const merchant = await openAccount(t.app, tenant);
      await transfer(t.app, tenant, wallet.id, merchant.id, "1");
    }
    const [first, second] = await Promise.all([t.dispatcher.runOnce(), t.dispatcher.runOnce()]);
    expect(first.delivered + second.delivered).toBe(7);
    expect(new Set(t.sender.deliveries.map((d) => d.event.id)).size).toBe(7);
  });

  it("stops between batches when asked", async () => {
    await fundedWallet(t.app, tenant, "1000");
    t.dispatcher.start();
    await t.dispatcher.stop();
    expect(t.sender.deliveries).toHaveLength(1);
  });
});
