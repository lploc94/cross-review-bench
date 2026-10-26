import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildTestApp, type TestApp } from "../helpers/app.js";
import { createTenant, expectStatus, storeFile, type FileBody, type TestTenant } from "../helpers/fixtures.js";

interface Page {
  data: FileBody[];
  nextCursor: string | null;
}

describe("listing files", () => {
  let t: TestApp;
  let tenant: TestTenant;

  beforeEach(async () => {
    t = await buildTestApp({ env: { LIST_MAX_LIMIT: "50" } });
    tenant = await createTenant(t.pool, t.clock);
  });

  afterEach(async () => {
    await t.close();
  });

  async function page(query: string): Promise<Page> {
    const response = await t.app.inject({ url: `/v1/files${query}`, headers: tenant.headers });
    expectStatus(response, 200);
    return response.json<Page>();
  }

  it("lists live files in byte order of their paths, page by page", async () => {
    const paths = ["b.txt", "a/z.txt", "a/b.txt", "Z.txt", "é.txt", "a-b.txt"];
    for (const p of paths) await storeFile(t.app, tenant, p, p);
    await storeFile(t.app, tenant, "gone.txt", "x");
    expectStatus(await t.app.inject({ method: "DELETE", url: "/v1/files/gone.txt", headers: tenant.headers }), 204);

    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const current: Page = await page(`?limit=4${cursor ? `&after=${encodeURIComponent(cursor)}` : ""}`);
      seen.push(...current.data.map((file) => file.path));
      cursor = current.nextCursor;
      pages++;
    } while (cursor !== null && pages < 10);
    expect(seen).toEqual(["Z.txt", "a-b.txt", "a/b.txt", "a/z.txt", "b.txt", "é.txt"]);
    expect(pages).toBe(2);
  });

  it("returns no cursor when the last page is exactly full", async () => {
    for (const p of ["a", "b"]) await storeFile(t.app, tenant, p, p);
    const result = await page("?limit=2");
    expect(result.data).toHaveLength(2);
    expect(result.nextCursor).toBeNull();
  });

  it("shows only the caller's files", async () => {
    const other = await createTenant(t.pool, t.clock, { name: "Harbor Logistics" });
    await storeFile(t.app, other, "theirs.txt", "x");
    await storeFile(t.app, tenant, "mine.txt", "x");
    expect((await page("")).data.map((file) => file.path)).toEqual(["mine.txt"]);
  });

  it.each([["?limit=0"], ["?limit=51"], ["?limit=abc"], ["?limit="], ["?after=not-a-cursor"]])(
    "rejects %s",
    async (query) => {
      const response = await t.app.inject({ url: `/v1/files${query}`, headers: tenant.headers });
      expectStatus(response, 400);
    },
  );
});
