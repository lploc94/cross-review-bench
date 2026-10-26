import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildTestApp, type TestApp } from "../helpers/app.js";
import { createTenant, fundedWallet, openAccount, transfer, type TestTenant } from "../helpers/fixtures.js";

interface StatementBody {
  opening_balance: string;
  closing_balance: string;
  entries: { transfer_id: string; amount: string; balance_after: string }[];
}

describe("statement balances with later activity", () => {
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

  async function statement(accountId: string, from: string, to: string): Promise<StatementBody> {
    const response = await t.app.inject({
      method: "GET",
      url: `/accounts/${accountId}/statement?from=${from}&to=${to}`,
      headers: tenant.headers,
    });
    expect(response.statusCode).toBe(200);
    return response.json<StatementBody>();
  }

  async function ledger() {
    t.clock.set("2030-01-20T08:00:00.000Z");
    const wallet = await fundedWallet(t.app, tenant, "1000");
    const merchant = await openAccount(t.app, tenant);
    t.clock.set("2030-02-03T12:00:00.000Z");
    const february = await transfer(t.app, tenant, wallet.id, merchant.id, "275");
    t.clock.set("2030-03-05T16:00:00.000Z");
    await transfer(t.app, tenant, wallet.id, merchant.id, "100");
    t.clock.set("2030-04-01T09:00:00.000Z");
    await transfer(t.app, tenant, merchant.id, wallet.id, "40");
    return { wallet, february };
  }

  it("uses the balance at the start of the period, not today's", async () => {
    const { wallet, february } = await ledger();
    const body = await statement(wallet.id, "2030-02-01", "2030-02-28");
    expect(body.entries.map((e) => [e.transfer_id, e.amount, e.balance_after])).toEqual([
      [february.id, "-275", "725"],
    ]);
    expect(body.opening_balance).toBe("1000");
    expect(body.closing_balance).toBe("725");
  });

  it("reports the balance of the time for a quiet period followed by activity", async () => {
    const { wallet } = await ledger();
    const body = await statement(wallet.id, "2030-01-25", "2030-01-31");
    expect(body.entries).toEqual([]);
    expect(body.opening_balance).toBe("1000");
    expect(body.closing_balance).toBe("1000");
  });
});
