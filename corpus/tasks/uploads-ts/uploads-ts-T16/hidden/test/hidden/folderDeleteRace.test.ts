import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PoolClient } from "../../src/db/pool.js";
import { createLogger } from "../../src/infra/logger.js";
import * as files from "../../src/repositories/fileRepo.js";
import * as tenants from "../../src/repositories/tenantRepo.js";
import { buildTestApp, type TestApp } from "../helpers/app.js";
import { createTenant, expectStatus, storeFile, tenantUsage, type FileBody, type TestTenant } from "../helpers/fixtures.js";

interface FolderDeletion {
  deleted: number;
  bytes: number;
  more: boolean;
}

describe("folder delete racing a single-file delete", () => {
  let t: TestApp;
  let tenant: TestTenant;
  let a: FileBody;

  beforeEach(async () => {
    t = await buildTestApp();
    tenant = await createTenant(t.pool, t.clock);
    a = await storeFile(t.app, tenant, "reports/a.txt", "a".repeat(100));
    await storeFile(t.app, tenant, "reports/b.txt", "b".repeat(200));
    await storeFile(t.app, tenant, "other/c.txt", "c".repeat(1000));
    expect(await tenantUsage(t.pool, tenant.tenantId)).toBe(1300);
  });

  afterEach(async () => {
    await t.close();
  });

  function deleteFolder() {
    return t.app.inject({ method: "DELETE", url: "/v1/files?prefix=reports/", headers: tenant.headers });
  }

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

  async function inTransaction(run: (client: PoolClient) => Promise<void>): Promise<PoolClient> {
    const client = await t.pool.connect();
    await client.query("BEGIN");
    await run(client);
    return client;
  }

  it("does not release a file's bytes again when a single delete of it commits first", async () => {
    const holder = await inTransaction(async (client) => {
      const row = await files.markDeleted(client, tenant.tenantId, a.id, t.clock.now());
      expect(row?.id).toBe(a.id);
      await tenants.releaseBytes(client, tenant.tenantId, 100, createLogger({ level: "silent" }));
    });
    try {
      const folder = deleteFolder();
      await lockWaiters(1);
      await holder.query("COMMIT");
      const response = await folder;
      expectStatus(response, 200);
      expect(response.json<FolderDeletion>()).toEqual(
        expect.objectContaining({ deleted: 1, bytes: 200, more: false }),
      );
    } finally {
      holder.release();
    }
    expect(await tenantUsage(t.pool, tenant.tenantId)).toBe(1000);
  });

  it("gives a file locked by another transaction to exactly one of the two deletes", async () => {
    const holder = await inTransaction(async (client) => {
      await client.query("SELECT id FROM files WHERE id = $1 FOR UPDATE", [a.id]);
    });
    let folderResponse;
    let singleResponse;
    try {
      const folder = deleteFolder();
      await lockWaiters(1);
      const single = t.app.inject({ method: "DELETE", url: "/v1/files/reports/a.txt", headers: tenant.headers });
      await lockWaiters(2);
      await holder.query("ROLLBACK");
      [folderResponse, singleResponse] = await Promise.all([folder, single]);
    } finally {
      holder.release();
    }
    expectStatus(folderResponse, 200);
    const result = folderResponse.json<FolderDeletion>();
    if (singleResponse.statusCode === 204) {
      expect(result).toEqual(expect.objectContaining({ deleted: 1, bytes: 200 }));
    } else {
      expect(singleResponse.statusCode).toBe(404);
      expect(result).toEqual(expect.objectContaining({ deleted: 2, bytes: 300 }));
    }
    expect(await tenantUsage(t.pool, tenant.tenantId)).toBe(1000);
    const live = await t.pool.query("SELECT 1 FROM files WHERE tenant_id = $1 AND status <> 'deleted'", [
      tenant.tenantId,
    ]);
    expect(live.rowCount).toBe(1);
  });
});
