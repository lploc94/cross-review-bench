import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCleanupService } from "../../src/app.js";
import type { PoolClient } from "../../src/db/pool.js";
import { createLogger } from "../../src/infra/logger.js";
import * as files from "../../src/repositories/fileRepo.js";
import * as tenants from "../../src/repositories/tenantRepo.js";
import { buildTestApp, type TestApp } from "../helpers/app.js";
import { createTenant, expectStatus, storeFile, tenantUsage, type FileBody, type TestTenant } from "../helpers/fixtures.js";

const DAY_S = 86_400;

describe("retention racing other deletes of the same file", () => {
  let t: TestApp;
  let tenant: TestTenant;
  let a: FileBody;

  beforeEach(async () => {
    t = await buildTestApp();
    tenant = await createTenant(t.pool, t.clock);
    a = await storeFile(t.app, tenant, "old/a.txt", "a".repeat(100));
    await storeFile(t.app, tenant, "old/b.txt", "b".repeat(200));
    await storeFile(t.app, tenant, "keep/c.txt", "c".repeat(1000));
    const rule = await t.app.inject({
      method: "PUT",
      url: "/v1/retention/old/",
      headers: tenant.headers,
      payload: { days: 30 },
    });
    expectStatus(rule, 200);
    t.clock.advanceSeconds(31 * DAY_S);
    expect(await tenantUsage(t.pool, tenant.tenantId)).toBe(1300);
  });

  afterEach(async () => {
    await t.close();
  });

  /** Wait until `count` backends of this database are blocked on a lock. */
  async function lockWaiters(count: number): Promise<void> {
    for (let attempt = 0; attempt < 500; attempt++) {
      const result = await t.pool.query<{ waiting: number }>(
        `SELECT count(*)::int AS waiting FROM pg_stat_activity
         WHERE datname = current_database() AND wait_event_type = 'Lock'`,
      );
      if ((result.rows[0]?.waiting ?? 0) >= count) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`fewer than ${count} backends ever waited on a lock`);
  }

  async function openTransaction(run: (client: PoolClient) => Promise<void>): Promise<PoolClient> {
    const client = await t.pool.connect();
    await client.query("BEGIN");
    await run(client);
    return client;
  }

  async function liveSizes(): Promise<number> {
    const result = await t.pool.query<{ total: string | null }>(
      "SELECT sum(size)::text AS total FROM files WHERE tenant_id = $1 AND status <> 'deleted'",
      [tenant.tenantId],
    );
    return Number(result.rows[0]?.total ?? 0);
  }

  it("does not release the bytes of a file a user deleted after the job picked it", async () => {
    const userDelete = await openTransaction(async (client) => {
      const row = await files.markDeleted(client, tenant.tenantId, a.id, t.clock.now());
      expect(row?.id).toBe(a.id);
      await tenants.releaseBytes(client, tenant.tenantId, 100, createLogger({ level: "silent" }));
    });
    try {
      const run = t.cleanup.applyRetention();
      await lockWaiters(1);
      await userDelete.query("COMMIT");
      await run;
    } finally {
      userDelete.release();
    }
    expect(await liveSizes()).toBe(1000);
    expect(await tenantUsage(t.pool, tenant.tenantId)).toBe(1000);
  });

  it("releases each file's bytes once when two cleanup runs pick the same files", async () => {
    const second = createCleanupService({
      pool: t.pool,
      clock: t.clock,
      logger: createLogger({ level: "silent" }),
      storage: t.storage,
      scanner: t.scanner,
      config: t.config,
    });
    const holder = await openTransaction(async (client) => {
      await client.query("SELECT id FROM files WHERE id = $1 FOR UPDATE", [a.id]);
    });
    try {
      const first = t.cleanup.applyRetention();
      const other = second.applyRetention();
      await lockWaiters(2);
      await holder.query("ROLLBACK");
      await Promise.all([first, other]);
    } finally {
      holder.release();
    }
    expect(await liveSizes()).toBe(1000);
    expect(await tenantUsage(t.pool, tenant.tenantId)).toBe(1000);
  });
});
