import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildTestApp, type TestApp } from "../helpers/app.js";
import {
  createHold,
  createTenant,
  fundedWallet,
  getAccount,
  type HoldBody,
  type TestTenant,
} from "../helpers/fixtures.js";

describe("cached account reads and holds", () => {
  let t: TestApp;
  let tenant: TestTenant;

  beforeAll(async () => {
    t = await buildTestApp({ env: { BALANCE_CACHE_TTL_S: "300" } });
  });

  afterAll(async () => {
    await t.close();
  });

  beforeEach(async () => {
    tenant = await createTenant(t.pool, t.clock);
  });

  it("shows a new hold in held and available right after it is created", async () => {
    const wallet = await fundedWallet(t.app, tenant, "1000");
    expect(await getAccount(t.app, tenant, wallet.id)).toMatchObject({ held: "0", available: "1000" });

    const created = await createHold(t.app, tenant, { account_id: wallet.id, amount: "300" });
    expect(created.statusCode).toBe(201);
    expect(await getAccount(t.app, tenant, wallet.id)).toMatchObject({
      balance: "1000",
      held: "300",
      available: "700",
    });
  });

  it("releases a voided hold in the account read right after the void", async () => {
    const wallet = await fundedWallet(t.app, tenant, "1000");
    const created = await createHold(t.app, tenant, { account_id: wallet.id, amount: "300" });
    const hold = created.json<HoldBody>();
    expect(await getAccount(t.app, tenant, wallet.id)).toMatchObject({ held: "300", available: "700" });

    const voided = await t.app.inject({
      method: "POST",
      url: `/holds/${hold.id}/void`,
      headers: tenant.headers,
    });
    expect(voided.statusCode).toBe(200);
    expect(await getAccount(t.app, tenant, wallet.id)).toMatchObject({
      balance: "1000",
      held: "0",
      available: "1000",
    });
  });
});
