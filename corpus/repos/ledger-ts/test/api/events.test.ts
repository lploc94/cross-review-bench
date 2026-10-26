import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildTestApp, type TestApp } from "../helpers/app.js";
import {
  createHold,
  createTenant,
  fundedWallet,
  issueKey,
  openAccount,
  transfer,
  type HoldBody,
  type TestTenant,
} from "../helpers/fixtures.js";

interface EventBody {
  id: string;
  type: string;
  aggregate_id: string;
  created_at: string;
  data: Record<string, unknown>;
  delivery: {
    status: string;
    attempts: number;
    delivered_at: string | null;
    next_attempt_at: string | null;
    last_error: string | null;
  };
}

describe("events", () => {
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

  async function list(query = ""): Promise<EventBody[]> {
    const response = await t.app.inject({ method: "GET", url: `/events?${query}`, headers: tenant.headers });
    expect(response.statusCode).toBe(200);
    return response.json<{ data: EventBody[] }>().data;
  }

  it("lists the tenant's events newest first with their delivery state", async () => {
    const wallet = await fundedWallet(t.app, tenant, "1000");
    const hold = (await createHold(t.app, tenant, { account_id: wallet.id, amount: "100" })).json<HoldBody>();

    const events = await list();
    expect(events.map((e) => e.type)).toEqual(["hold.created", "transfer.posted"]);
    expect(events[0]).toMatchObject({
      aggregate_id: hold.id,
      data: { hold: { id: hold.id, amount: "100", status: "active" } },
      delivery: { status: "pending", attempts: 0, delivered_at: null, last_error: null },
    });

    await t.dispatcher.runOnce();
    const [latest] = await list();
    expect(latest?.delivery).toMatchObject({ status: "delivered", attempts: 1, next_attempt_at: null });
  });

  it("filters by type, aggregate and creation time", async () => {
    const wallet = await fundedWallet(t.app, tenant, "1000");
    const merchant = await openAccount(t.app, tenant);
    t.clock.advanceSeconds(60);
    const later = await transfer(t.app, tenant, wallet.id, merchant.id, "5");
    await createHold(t.app, tenant, { account_id: wallet.id, amount: "100" });

    expect((await list("type=transfer.posted")).map((e) => e.aggregate_id)).toHaveLength(2);
    expect((await list(`aggregate_id=${later.id}`)).map((e) => e.type)).toEqual(["transfer.posted"]);
    const recent = await list(`created_from=${encodeURIComponent(later.created_at)}`);
    expect(recent.map((e) => e.type)).toEqual(["hold.created", "transfer.posted"]);
  });

  it("reads one event and hides other tenants' events", async () => {
    await fundedWallet(t.app, tenant, "1000");
    const [event] = await list();
    const read = await t.app.inject({ method: "GET", url: `/events/${event?.id}`, headers: tenant.headers });
    expect(read.statusCode).toBe(200);
    expect(read.json()).toEqual(event);

    const other = await createTenant(t.pool, t.clock, { name: "Other" });
    const foreign = await t.app.inject({ method: "GET", url: `/events/${event?.id}`, headers: other.headers });
    expect(foreign.statusCode).toBe(404);
    const malformed = await t.app.inject({ method: "GET", url: "/events/abc", headers: tenant.headers });
    expect(malformed.statusCode).toBe(400);
  });

  it("requires the webhooks:manage scope", async () => {
    const reader = await issueKey(t.pool, t.clock, tenant.tenantId, ["transfers:read"]);
    const response = await t.app.inject({ method: "GET", url: "/events", headers: reader.headers });
    expect(response.statusCode).toBe(403);
  });
});
