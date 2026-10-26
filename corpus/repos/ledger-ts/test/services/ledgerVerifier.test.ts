import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { LedgerVerifier } from "../../src/services/ledgerVerifier.js";
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

describe("LedgerVerifier", () => {
  let t: TestApp;
  let tenant: TestTenant;
  let verifier: LedgerVerifier;

  beforeAll(async () => {
    t = await buildTestApp();
    verifier = new LedgerVerifier({ pool: t.pool });
  });

  afterAll(async () => {
    await t.close();
  });

  beforeEach(async () => {
    tenant = await createTenant(t.pool, t.clock);
  });

  async function busyLedger() {
    const wallet = await fundedWallet(t.app, tenant, "1000");
    const merchant = await openAccount(t.app, tenant);
    await transfer(t.app, tenant, wallet.id, merchant.id, "100");
    const captured = (await createHold(t.app, tenant, { account_id: wallet.id, amount: "200" })).json<HoldBody>();
    await t.app.inject({
      method: "POST",
      url: `/holds/${captured.id}/capture`,
      headers: tenant.headers,
      payload: { to_account_id: merchant.id },
    });
    await createHold(t.app, tenant, { account_id: wallet.id, amount: "50" });
    return { wallet, merchant };
  }

  it("finds nothing wrong with a ledger written through the API", async () => {
    await busyLedger();
    expect(await verifier.verifyTenant(tenant.tenantId)).toEqual({ tenantId: tenant.tenantId, problems: [] });
  });

  it("reports a balance that does not match the entries", async () => {
    const { merchant } = await busyLedger();
    await t.pool.query("UPDATE accounts SET balance_minor = balance_minor + 1 WHERE id = $1", [merchant.id]);
    const report = await verifier.verifyTenant(tenant.tenantId);
    expect(report.problems).toEqual([
      { kind: "balance_mismatch", accountId: merchant.id, recorded: 301n, expected: 300n },
    ]);
  });

  it("reports held amounts that do not match the active holds", async () => {
    const { wallet } = await busyLedger();
    await t.pool.query("UPDATE accounts SET held_minor = 0 WHERE id = $1", [wallet.id]);
    const report = await verifier.verifyTenant(tenant.tenantId);
    expect(report.problems).toEqual([
      { kind: "held_mismatch", accountId: wallet.id, recorded: 0n, expected: 50n },
    ]);
  });

  it("reports transfers whose entries do not balance", async () => {
    await busyLedger();
    const { rows } = await t.pool.query<{ id: string; transfer_id: string }>(
      "SELECT id, transfer_id FROM entries WHERE amount_minor > 0 ORDER BY id LIMIT 1",
    );
    const entry = rows[0];
    await t.pool.query("UPDATE entries SET amount_minor = amount_minor + 1 WHERE id = $1", [entry?.id]);
    const kinds = (await verifier.verifyTenant(tenant.tenantId)).problems.map((p) => p.kind);
    expect(kinds).toContain("unbalanced_transfer");
    expect(kinds).toContain("balance_mismatch");
  });

  it("checks every tenant", async () => {
    await busyLedger();
    const other = await createTenant(t.pool, t.clock, { name: "Other" });
    const reports = await verifier.verifyAll();
    expect(reports.map((r) => r.tenantId).sort()).toEqual([tenant.tenantId, other.tenantId].sort());
    expect(reports.every((r) => r.problems.length === 0)).toBe(true);
  });
});
