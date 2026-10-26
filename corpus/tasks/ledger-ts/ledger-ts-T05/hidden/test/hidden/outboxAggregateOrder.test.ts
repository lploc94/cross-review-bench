import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createOutboxDispatcher } from "../../src/app.js";
import { createLogger } from "../../src/infra/logger.js";
import {
  WebhookDeliveryError,
  type WebhookDelivery,
  type WebhookSender,
} from "../../src/services/webhookSender.js";
import type { OutboxDispatcher } from "../../src/services/outboxDispatcher.js";
import { buildTestApp, type TestApp } from "../helpers/app.js";
import { createHold, createTenant, fundedWallet, type HoldBody, type TestTenant } from "../helpers/fixtures.js";

const ENDPOINT = "https://hooks.example.com/ordered";

interface Started {
  readonly type: string;
  readonly settle: (ok: boolean) => void;
}

/** Deliveries stay pending until the test settles them (or `releaseAll` lets everything through). */
class ControlledSender implements WebhookSender {
  readonly started: Started[] = [];
  private released = false;
  private waiters: (() => void)[] = [];

  send(delivery: WebhookDelivery): Promise<void> {
    const type = delivery.headers["x-ledger-event-type"] ?? "";
    return new Promise<void>((resolve, reject) => {
      const settle = (ok: boolean) =>
        ok ? resolve() : reject(new WebhookDeliveryError("endpoint answered HTTP 503", { status: 503 }));
      this.started.push({ type, settle });
      if (this.released) settle(true);
      for (const wake of this.waiters.splice(0)) wake();
    });
  }

  types(): string[] {
    return this.started.map((s) => s.type);
  }

  async waitForStarted(count: number): Promise<void> {
    while (this.started.length < count) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
  }

  releaseAll(): void {
    this.released = true;
    for (const s of this.started) s.settle(true);
  }
}

/** Fails every delivery of one event type, accepts the rest at once. */
class FailingTypeSender implements WebhookSender {
  readonly types: string[] = [];
  failing: string | null;

  constructor(failing: string) {
    this.failing = failing;
  }

  async send(delivery: WebhookDelivery): Promise<void> {
    const type = delivery.headers["x-ledger-event-type"] ?? "";
    this.types.push(type);
    if (type === this.failing) {
      throw new WebhookDeliveryError("endpoint answered HTTP 503", { status: 503 });
    }
  }
}

async function turns(count: number): Promise<void> {
  for (let i = 0; i < count; i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

describe("outbox delivery order within one aggregate", () => {
  let t: TestApp;
  let tenant: TestTenant;

  beforeAll(async () => {
    t = await buildTestApp();
  });

  afterAll(async () => {
    await t.close();
  });

  beforeEach(async () => {
    t.sender.deliveries.length = 0;
    tenant = await createTenant(t.pool, t.clock);
    const created = await t.app.inject({
      method: "POST",
      url: "/webhooks",
      headers: tenant.headers,
      payload: { url: ENDPOINT },
    });
    expect(created.statusCode).toBe(201);
    const wallet = await fundedWallet(t.app, tenant, "1000");
    await t.dispatcher.runOnce();
    const hold = (await createHold(t.app, tenant, { account_id: wallet.id, amount: "100" })).json<HoldBody>();
    const voided = await t.app.inject({ method: "POST", url: `/holds/${hold.id}/void`, headers: tenant.headers });
    expect(voided.statusCode).toBe(200);
  });

  function dispatcherWith(sender: WebhookSender): OutboxDispatcher {
    return createOutboxDispatcher({
      pool: t.pool,
      clock: t.clock,
      sender,
      logger: createLogger({ level: "silent" }),
      config: t.config,
    });
  }

  async function deliveredTypes(): Promise<Record<string, boolean>> {
    const result = await t.pool.query<{ event_type: string; delivered: boolean }>(
      "SELECT event_type, delivered_at IS NOT NULL AS delivered FROM outbox WHERE event_type LIKE 'hold.%'",
    );
    return Object.fromEntries(result.rows.map((row) => [row.event_type, row.delivered]));
  }

  it("does not start an aggregate's next event before the previous one is answered", async () => {
    expect(t.config.outbox.concurrency).toBeGreaterThan(1);
    const sender = new ControlledSender();
    const run = dispatcherWith(sender).runOnce();
    try {
      await sender.waitForStarted(1);
      await turns(10);
      expect(sender.types()).toEqual(["hold.created"]);

      sender.started[0]?.settle(true);
      await sender.waitForStarted(2);
      expect(sender.types()).toEqual(["hold.created", "hold.voided"]);
      sender.started[1]?.settle(true);
      expect(await run).toEqual({ claimed: 2, delivered: 2, failed: 0 });
    } finally {
      sender.releaseAll();
      await run.catch(() => undefined);
    }
  });

  it("keeps an aggregate's later events undelivered while an earlier one fails", async () => {
    const sender = new FailingTypeSender("hold.created");
    const dispatcher = dispatcherWith(sender);

    const summary = await dispatcher.runOnce();
    expect(summary).toMatchObject({ delivered: 0, failed: 1 });
    expect(sender.types).toEqual(["hold.created"]);
    expect(await deliveredTypes()).toEqual({ "hold.created": false, "hold.voided": false });

    // Nothing of the aggregate goes out while its first event waits for the retry.
    expect(await dispatcher.runOnce()).toMatchObject({ claimed: 0 });
    expect(await deliveredTypes()).toEqual({ "hold.created": false, "hold.voided": false });

    sender.failing = null;
    t.clock.advance(dispatcher.backoffDelayMs(1));
    expect(await dispatcher.runOnce()).toEqual({ claimed: 2, delivered: 2, failed: 0 });
    expect(sender.types).toEqual(["hold.created", "hold.created", "hold.voided"]);
    expect(await deliveredTypes()).toEqual({ "hold.created": true, "hold.voided": true });
  });
});
