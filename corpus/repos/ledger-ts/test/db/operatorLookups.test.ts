import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { findAccountById } from "../../src/repositories/accounts.js";
import { findTransfer, findTransferById } from "../../src/repositories/transfers.js";
import { buildTestApp, type TestApp } from "../helpers/app.js";
import { createTenant, fundedWallet, openAccount, transfer, type TestTenant } from "../helpers/fixtures.js";

describe("operator lookups across tenants", () => {
  let t: TestApp;
  let first: TestTenant;
  let second: TestTenant;

  beforeAll(async () => {
    t = await buildTestApp();
  });

  afterAll(async () => {
    await t.close();
  });

  beforeEach(async () => {
    first = await createTenant(t.pool, t.clock);
    second = await createTenant(t.pool, t.clock);
  });

  it("finds a transfer and its accounts whichever tenant owns them", async () => {
    const wallet = await fundedWallet(t.app, first, "500");
    const merchant = await openAccount(t.app, first);
    const posted = await transfer(t.app, first, wallet.id, merchant.id, "120");

    const found = await findTransferById(t.pool, posted.id);
    expect(found).toMatchObject({ id: posted.id, tenantId: first.tenantId, amountMinor: 120n });
    expect(await findAccountById(t.pool, merchant.id)).toMatchObject({ id: merchant.id, tenantId: first.tenantId });
    // request paths stay scoped: the other tenant cannot see it
    expect(await findTransfer(t.pool, second.tenantId, posted.id)).toBeNull();
  });

  it("returns null for ids that do not exist", async () => {
    expect(await findTransferById(t.pool, "00000000-0000-4000-8000-000000000000")).toBeNull();
    expect(await findAccountById(t.pool, "00000000-0000-4000-8000-000000000000")).toBeNull();
  });
});
