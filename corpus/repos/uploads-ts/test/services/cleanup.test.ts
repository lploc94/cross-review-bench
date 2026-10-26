import { access } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildTestApp, type TestApp } from "../helpers/app.js";
import { createTenant, expectStatus, storeFile, tenantUsage, type SessionBody, type TestTenant } from "../helpers/fixtures.js";
import { chunkedStream } from "../helpers/streams.js";

describe("cleanup", () => {
  let t: TestApp;
  let tenant: TestTenant;

  beforeEach(async () => {
    t = await buildTestApp({
      env: { UPLOAD_SESSION_TTL_S: "600", DELETED_GRACE_S: "3600", CLEANUP_BATCH_SIZE: "2" },
    });
    tenant = await createTenant(t.pool, t.clock);
  });

  afterEach(async () => {
    await t.close();
  });

  async function openSession(filePath: string, size: number): Promise<SessionBody> {
    const response = await t.app.inject({
      method: "POST",
      url: "/v1/uploads",
      headers: tenant.headers,
      payload: { path: filePath, size },
    });
    expectStatus(response, 201);
    return response.json<SessionBody>();
  }

  it("expires sessions past their expiry in batches, releasing their bytes and chunks", async () => {
    const sessions: SessionBody[] = [];
    for (const name of ["a", "b", "c"]) sessions.push(await openSession(`${name}.bin`, 100));
    const first = sessions[0];
    if (!first) throw new Error("no session");
    await t.storage.stagePart(first.id, 1, chunkedStream(["staged"]));
    expect(await tenantUsage(t.pool, tenant.tenantId)).toBe(300);

    expect((await t.cleanup.runOnce()).expiredSessions).toBe(0);
    t.clock.advanceSeconds(600);
    const report = await t.cleanup.runOnce();
    expect(report.expiredSessions).toBe(3);
    expect(await tenantUsage(t.pool, tenant.tenantId)).toBe(0);
    expect(await t.storage.listStaging()).toEqual([]);
    const states = await t.pool.query<{ state: string }>("SELECT DISTINCT state FROM upload_sessions");
    expect(states.rows).toEqual([{ state: "expired" }]);
  });

  it("removes staged chunks of no open session, and keeps those of open ones", async () => {
    const open = await openSession("a.bin", 100);
    await t.storage.stagePart(open.id, 1, chunkedStream(["keep"]));
    const orphan = "7d6e5f4a-0000-4000-8000-0000000000aa";
    await t.storage.stagePart(orphan, 1, chunkedStream(["drop"]));
    expect((await t.cleanup.runOnce()).orphanedStaging).toBe(1);
    expect(await t.storage.listStaging()).toEqual([open.id]);
  });

  it("purges objects of deleted files that are still stored once the grace period is over", async () => {
    const file = await storeFile(t.app, tenant, "a.txt", "remove me");
    // A delete whose storage removal failed: the row is deleted, the object is still there.
    await t.pool.query("UPDATE files SET status = 'deleted', deleted_at = $2 WHERE id = $1", [
      file.id,
      t.clock.now(),
    ]);
    const objectPath = path.join(t.storageRoot ?? "", "objects", "t", tenant.tenantId, file.id);

    expect((await t.cleanup.runOnce()).purgedObjects).toBe(0);
    await access(objectPath);

    t.clock.advanceSeconds(3600);
    expect((await t.cleanup.runOnce()).purgedObjects).toBe(1);
    await expect(access(objectPath)).rejects.toThrow();
    const row = await t.pool.query<{ object_deleted_at: Date | null }>(
      "SELECT object_deleted_at FROM files WHERE id = $1",
      [file.id],
    );
    expect(row.rows[0]?.object_deleted_at).not.toBeNull();
    expect((await t.cleanup.runOnce()).purgedObjects).toBe(0);
  });

  it("does not let a completing session's chunks be taken for orphans", async () => {
    const session = await openSession("a.bin", 4);
    await t.storage.stagePart(session.id, 1, chunkedStream(["data"]));
    const client = await t.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT id FROM upload_sessions WHERE id = $1 FOR UPDATE", [session.id]);
      expect((await t.cleanup.runOnce()).orphanedStaging).toBe(0);
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
    expect(await t.storage.listStaging()).toEqual([session.id]);
  });
});
