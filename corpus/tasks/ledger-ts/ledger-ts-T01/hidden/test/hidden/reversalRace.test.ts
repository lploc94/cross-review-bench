import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as transferRepository from "../../src/repositories/transfers.js";
import { buildTestApp, type TestApp } from "../helpers/app.js";
import {
  createTenant,
  fundedWallet,
  getAccount,
  transfer,
  type TestTenant,
} from "../helpers/fixtures.js";

type TransferRepository = typeof import("../../src/repositories/transfers.js");

vi.mock("../../src/repositories/transfers.js", async (importOriginal) => {
  const actual = await importOriginal<TransferRepository>();
  return { ...actual, findReversal: vi.fn(actual.findReversal) };
});

describe("concurrent reversals of one transfer", () => {
  let t: TestApp;
  let tenant: TestTenant;
  let actual: TransferRepository;

  beforeAll(async () => {
    t = await buildTestApp();
    actual = await vi.importActual<TransferRepository>("../../src/repositories/transfers.js");
  });

  afterAll(async () => {
    await t.close();
  });

  beforeEach(async () => {
    tenant = await createTenant(t.pool, t.clock);
  });

  /**
   * The first reversal to look for an existing reversal waits there until a second request has
   * looked too (or 300 ms pass, when the second request is held back before its own lookup).
   */
  function holdFirstLookup(): void {
    let calls = 0;
    let release: (() => void) | null = null;
    vi.mocked(transferRepository.findReversal).mockImplementation(async (...args) => {
      const found = await actual.findReversal(...args);
      calls += 1;
      if (calls === 1) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 300);
          release = () => {
            clearTimeout(timer);
            resolve();
          };
        });
      } else {
        release?.();
      }
      return found;
    });
  }

  it("posts exactly one reversal and refuses the other", async () => {
    const wallet = await fundedWallet(t.app, tenant, "1000");
    const merchant = await fundedWallet(t.app, tenant, "5000");
    const original = await transfer(t.app, tenant, wallet.id, merchant.id, "300");

    holdFirstLookup();
    const responses = await Promise.all(
      [0, 1].map(() =>
        t.app.inject({
          method: "POST",
          url: `/transfers/${original.id}/reverse`,
          headers: tenant.headers,
        }),
      ),
    );

    expect(responses.map((r) => r.statusCode).sort()).toEqual([201, 409]);
    const reversals = await t.pool.query("SELECT id FROM transfers WHERE reversal_of = $1", [original.id]);
    expect(reversals.rowCount).toBe(1);
    expect((await getAccount(t.app, tenant, wallet.id)).balance).toBe("1000");
    expect((await getAccount(t.app, tenant, merchant.id)).balance).toBe("5000");
  });
});
