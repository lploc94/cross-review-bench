import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ApiKeyService } from "../../src/services/apiKeyService.js";
import { buildTestApp, type TestApp } from "../helpers/app.js";
import {
  createTenant,
  fundedWallet,
  issueKey,
  openAccount,
  transferRequest,
  type AccountBody,
  type ErrorResponse,
  type TestTenant,
} from "../helpers/fixtures.js";

// Run with a non-UTC TZ (the command sets America/Los_Angeles): the limit day is a UTC day
// whatever the server's local time zone.
describe("daily transfer limit window", () => {
  let t: TestApp;
  let tenant: TestTenant;
  let limited: TestTenant;
  let wallet: AccountBody;
  let merchant: AccountBody;

  beforeAll(async () => {
    t = await buildTestApp();
  });

  afterAll(async () => {
    await t.close();
  });

  beforeEach(async () => {
    t.clock.set("2030-01-10T12:00:00.000Z");
    tenant = await createTenant(t.pool, t.clock);
    wallet = await fundedWallet(t.app, tenant, "100000");
    merchant = await openAccount(t.app, tenant);
    limited = await issueKey(t.pool, t.clock, tenant.tenantId, ["transfers:write"]);
    await new ApiKeyService({ pool: t.pool, clock: t.clock }).setDailyTransferLimit(
      tenant.tenantId,
      limited.apiKeyId,
      { amountMinor: 1000n, currency: "USD" },
    );
  });

  function send(amount: string) {
    return transferRequest(t.app, limited, {
      from_account_id: wallet.id,
      to_account_id: merchant.id,
      amount,
      currency: "USD",
    });
  }

  it("resets at 00:00 UTC and reports that instant as resets_at", async () => {
    t.clock.set("2030-01-15T23:30:00.000Z");
    expect((await send("800")).statusCode).toBe(201);
    const refused = await send("300");
    expect(refused.statusCode).toBe(422);
    expect(refused.json<ErrorResponse>().error.details).toMatchObject({
      used: "800",
      remaining: "200",
      resets_at: "2030-01-16T00:00:00.000Z",
    });

    t.clock.set("2030-01-16T00:30:00.000Z");
    expect((await send("800")).statusCode).toBe(201);
  });

  it("counts transfers on both sides of local midnight in one UTC day", async () => {
    t.clock.set("2030-01-15T07:30:00.000Z");
    expect((await send("800")).statusCode).toBe(201);

    t.clock.set("2030-01-15T08:30:00.000Z");
    const refused = await send("800");
    expect(refused.statusCode).toBe(422);
    expect(refused.json<ErrorResponse>().error.details).toMatchObject({
      used: "800",
      remaining: "200",
      resets_at: "2030-01-16T00:00:00.000Z",
    });
  });
});
