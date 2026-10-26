import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { scanBackoffSeconds, ScanWorker } from "../../src/services/scanWorker.js";
import { buildTestApp, type TestApp } from "../helpers/app.js";
import { createTenant, storeFile, type TestTenant } from "../helpers/fixtures.js";

interface ScanRow {
  status: string;
  scan_attempts: number;
  next_scan_at: Date | null;
  scanned_at: Date | null;
}

describe("scan worker", () => {
  let t: TestApp;
  let tenant: TestTenant;

  beforeEach(async () => {
    t = await buildTestApp({
      env: { SCAN_MAX_ATTEMPTS: "3", SCAN_BACKOFF_BASE_S: "30", SCAN_BACKOFF_MAX_S: "100", SCAN_BATCH_SIZE: "2" },
    });
    tenant = await createTenant(t.pool, t.clock);
  });

  afterEach(async () => {
    await t.close();
  });

  async function scanRow(id: string): Promise<ScanRow> {
    const result = await t.pool.query<ScanRow>(
      "SELECT status, scan_attempts, next_scan_at, scanned_at FROM files WHERE id = $1",
      [id],
    );
    const row = result.rows[0];
    if (!row) throw new Error(`no file ${id}`);
    return row;
  }

  it("makes clean files available and quarantines infected ones", async () => {
    const clean = await storeFile(t.app, tenant, "clean.txt", "fine");
    t.clock.advanceSeconds(1);
    const infected = await storeFile(t.app, tenant, "infected.txt", "bad");
    t.scanner.next("clean", "infected");
    expect(await t.scanWorker.runOnce()).toEqual({ claimed: 2, available: 1, quarantined: 1, retried: 0 });
    expect((await scanRow(clean.id)).status).toBe("available");
    expect((await scanRow(infected.id)).status).toBe("quarantined");
    expect(t.scanner.scanned.map(String)).toEqual(["fine", "bad"]);
    expect(await t.scanWorker.runOnce()).toEqual({ claimed: 0, available: 0, quarantined: 0, retried: 0 });
  });

  it("claims at most a batch, oldest first", async () => {
    for (const name of ["a", "b", "c"]) {
      await storeFile(t.app, tenant, `${name}.txt`, name);
      t.clock.advanceSeconds(1);
    }
    const report = await t.scanWorker.runOnce();
    expect(report.claimed).toBe(2);
    expect(ScanWorker.hasMore(report, 2)).toBe(true);
    expect(t.scanner.scanned.map(String)).toEqual(["a", "b"]);
  });

  it("retries failed scans with backoff, then quarantines", async () => {
    const file = await storeFile(t.app, tenant, "flaky.txt", "x");
    t.scanner.next("error", "throw", "error");

    expect((await t.scanWorker.runOnce()).retried).toBe(1);
    let row = await scanRow(file.id);
    expect(row).toMatchObject({ status: "pending_scan", scan_attempts: 1 });
    expect(row.next_scan_at?.toISOString()).toBe("2030-01-15T10:00:30.000Z");
    expect((await t.scanWorker.runOnce()).claimed).toBe(0);

    t.clock.advanceSeconds(30);
    expect((await t.scanWorker.runOnce()).retried).toBe(1);
    row = await scanRow(file.id);
    expect(row.scan_attempts).toBe(2);
    expect(row.next_scan_at?.toISOString()).toBe("2030-01-15T10:01:30.000Z");

    t.clock.advanceSeconds(60);
    expect((await t.scanWorker.runOnce()).quarantined).toBe(1);
    expect(await scanRow(file.id)).toMatchObject({ status: "quarantined", scan_attempts: 3 });
  });

  it("counts a file missing from storage as a failed scan", async () => {
    const file = await storeFile(t.app, tenant, "gone.txt", "x");
    await t.storage.delete(`t/${tenant.tenantId}/${file.id}`);
    expect((await t.scanWorker.runOnce()).retried).toBe(1);
    expect(t.scanner.scanned).toEqual([]);
  });

  it("does not scan a file deleted before its turn", async () => {
    const file = await storeFile(t.app, tenant, "short-lived.txt", "x");
    await t.pool.query("UPDATE files SET status = 'deleted', deleted_at = now() WHERE id = $1", [file.id]);
    expect((await t.scanWorker.runOnce()).claimed).toBe(0);
    expect((await scanRow(file.id)).status).toBe("deleted");
  });

  it("caps the backoff", () => {
    const settings = { maxAttempts: 10, backoffBaseSeconds: 30, backoffMaxSeconds: 100, batchSize: 1, claimLeaseSeconds: 60 };
    expect([1, 2, 3, 4, 40].map((failures) => scanBackoffSeconds(failures, settings))).toEqual([30, 60, 100, 100, 100]);
  });
});
