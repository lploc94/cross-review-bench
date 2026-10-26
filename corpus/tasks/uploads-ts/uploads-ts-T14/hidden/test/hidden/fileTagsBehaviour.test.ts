import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildTestApp, type TestApp } from "../helpers/app.js";
import { createTenant, expectStatus, storeFile, type FileBody, type TestTenant } from "../helpers/fixtures.js";

interface Page {
  data: FileBody[];
  nextCursor: string | null;
}

describe("file tags (behaviour)", () => {
  let t: TestApp;
  let tenant: TestTenant;

  beforeEach(async () => {
    t = await buildTestApp();
    tenant = await createTenant(t.pool, t.clock);
  });

  afterEach(async () => {
    await t.close();
  });

  function tagRequest(method: "PUT" | "DELETE", fileId: string, tag: string) {
    return t.app.inject({ method, url: `/v1/files/by-id/${fileId}/tags/${tag}`, headers: tenant.headers });
  }

  async function listAll(query: string, limit: number): Promise<string[]> {
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let pages = 0; pages < 50; pages++) {
      const suffix: string = cursor === null ? "" : `&after=${encodeURIComponent(cursor)}`;
      const response = await t.app.inject({ url: `/v1/files?${query}&limit=${limit}${suffix}`, headers: tenant.headers });
      expectStatus(response, 200);
      const page = response.json<Page>();
      seen.push(...page.data.map((file) => file.path));
      cursor = page.nextCursor;
      if (cursor === null) break;
    }
    return seen;
  }

  it("pages through a tag's files without gaps or repeats", async () => {
    const expected: string[] = [];
    for (let i = 0; i < 12; i++) {
      const path = `dir${i % 3}/file-${String(i).padStart(2, "0")}.txt`;
      const file = await storeFile(t.app, tenant, path, path);
      if (i % 2 === 0) {
        expectStatus(await tagRequest("PUT", file.id, "even"), 200);
        expected.push(path);
      }
    }
    expected.sort();
    expect(await listAll("tag=even", 2)).toEqual(expected);
    expect(await listAll("tag=even", 100)).toEqual(expected);
  });

  it("stops listing a file once its tag is removed", async () => {
    const a = await storeFile(t.app, tenant, "a.txt", "a");
    const b = await storeFile(t.app, tenant, "b.txt", "b");
    for (const file of [a, b]) expectStatus(await tagRequest("PUT", file.id, "7"), 200);
    expectStatus(await tagRequest("DELETE", a.id, "7"), 200);
    expect(await listAll("tag=7", 10)).toEqual(["b.txt"]);
  });

  it("counts the limit per file", async () => {
    const a = await storeFile(t.app, tenant, "a.txt", "a");
    const b = await storeFile(t.app, tenant, "b.txt", "b");
    for (let i = 0; i < 20; i++) expectStatus(await tagRequest("PUT", a.id, `x${i}`), 200);
    expectStatus(await tagRequest("PUT", b.id, "x0"), 200);
    expectStatus(await tagRequest("PUT", a.id, "y"), 409);
  });

  it("tags files that are not available yet", async () => {
    const pending = await storeFile(t.app, tenant, "pending.bin", "p");
    expect(pending.status).toBe("pending_scan");
    const response = await tagRequest("PUT", pending.id, "inbox");
    expectStatus(response, 200);
    expect(await listAll("tag=inbox", 5)).toEqual(["pending.bin"]);
  });

  it("leaves no tag on a file deleted while it is being tagged", async () => {
    const file = await storeFile(t.app, tenant, "busy.txt", "x");
    const results = await Promise.all([
      ...Array.from({ length: 8 }, (_, i) => tagRequest("PUT", file.id, `busy-${i}`)),
      t.app.inject({ method: "DELETE", url: "/v1/files/busy.txt", headers: tenant.headers }),
      ...Array.from({ length: 8 }, (_, i) => tagRequest("PUT", file.id, `late-${i}`)),
    ]);
    for (const result of results) expect([200, 204, 404]).toContain(result.statusCode);
    const rows = await t.pool.query("SELECT tag FROM file_tags WHERE file_id = $1", [file.id]);
    expect(rows.rows).toEqual([]);
    expect(await listAll("tag=busy-0", 5)).toEqual([]);
  });
});
