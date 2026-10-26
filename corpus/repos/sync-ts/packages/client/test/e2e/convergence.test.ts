import { PULL_PATH, PUSH_PATH, type DocumentChange } from "@sync/client";
import { ManualClock } from "@sync/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openClient, type TestClient } from "../helpers/clients.js";
import { startTestServer, type TestAccount, type TestServer } from "../helpers/testServer.js";
import { tempDbPath } from "../helpers/tempFiles.js";

let server: TestServer;
let laptop: TestAccount;
let phone: TestAccount;
const opened: TestClient[] = [];

function client(account: TestAccount, options: Parameters<typeof openClient>[2] = {}): TestClient {
  const c = openClient(server, account, options);
  opened.push(c);
  return c;
}

beforeEach(async () => {
  server = await startTestServer();
  laptop = await server.createUser("Ada");
  phone = await server.addDevice(laptop);
});

afterEach(async () => {
  for (const c of opened.splice(0)) await c.client.close();
  await server.close();
});

describe("two devices of one user", () => {
  it("receive each other's writes", async () => {
    const a = client(laptop);
    const b = client(phone);
    a.client.set("notes", "n1", { title: "Trip", tags: ["travel"] });
    b.client.set("tasks", "t1", { title: "Book train", priority: 2 });

    // The laptop syncs first and only gets its own two field writes back.
    expect(await a.client.sync()).toEqual({ pushed: 1, pulled: 2, applied: 0 });
    expect(await b.client.sync()).toEqual({ pushed: 1, pulled: 4, applied: 2 });
    expect(await a.client.sync()).toEqual({ pushed: 0, pulled: 2, applied: 2 });

    for (const c of [a, b]) {
      expect(c.client.get("notes", "n1")?.fields).toEqual({ title: "Trip", tags: ["travel"] });
      expect(c.client.get("tasks", "t1")?.fields).toEqual({ title: "Book train", priority: 2 });
      expect(c.client.pendingCount()).toBe(0);
    }
    expect(a.client.pullCursor()).toBe(b.client.pullCursor());
  });

  it("merge concurrent edits field by field, the later write winning", async () => {
    const a = client(laptop);
    const b = client(phone);
    a.client.set("notes", "n1", { title: "Draft", body: "first" });
    await a.client.sync();
    await b.client.sync();

    a.client.set("notes", "n1", { title: "Laptop title" });
    b.clock.advance(5);
    b.client.set("notes", "n1", { title: "Phone title", pinned: true });
    a.clock.advance(10);
    a.client.set("notes", "n1", { body: "laptop body" });

    await a.client.sync();
    await b.client.sync();
    await a.client.sync();

    const expected = { title: "Phone title", body: "laptop body", pinned: true };
    expect(a.client.get("notes", "n1")?.fields).toEqual(expected);
    expect(b.client.get("notes", "n1")?.fields).toEqual(expected);
  });

  it("converge whatever order they sync in", async () => {
    const a = client(laptop);
    const b = client(phone);
    for (let i = 0; i < 6; i++) {
      a.clock.advance(3);
      b.clock.advance(2);
      a.client.set("tasks", "shared", { priority: i % 4, title: `a${i}` });
      b.client.set("tasks", "shared", { done: i % 2 === 0, title: `b${i}` });
      await (i % 2 === 0 ? a : b).client.sync();
    }
    await a.client.sync();
    await b.client.sync();
    await a.client.sync();
    expect(a.client.get("tasks", "shared")).toEqual(b.client.get("tasks", "shared"));
    expect(a.client.get("tasks", "shared")?.fields.title).toBe("a5");
  });

  it("page through a long feed with a small pull limit", async () => {
    const a = client(laptop, { pushBatchSize: 3 });
    const b = client(phone, { pullLimit: 4 });
    a.client.setMany(
      Array.from({ length: 10 }, (_, i) => ({ collection: "notes" as const, id: `n${i}`, fields: { title: `Note ${i}` } })),
    );
    expect(await a.client.sync()).toMatchObject({ pushed: 10 });
    expect(a.transport.count(PUSH_PATH)).toBe(4);

    expect(await b.client.sync()).toEqual({ pushed: 0, pulled: 10, applied: 10 });
    expect(b.transport.count(PULL_PATH)).toBe(3);
    expect(b.client.list("notes")).toHaveLength(10);
  });

  it("do not apply their own writes again when they come back", async () => {
    const a = client(laptop);
    a.client.set("notes", "n1", { title: "mine" });
    const changes: DocumentChange[] = [];
    a.client.onChange((change) => changes.push(change));
    expect(await a.client.sync()).toEqual({ pushed: 1, pulled: 1, applied: 0 });
    expect(changes).toEqual([]);
    expect(await a.client.sync()).toEqual({ pushed: 0, pulled: 0, applied: 0 });
  });

  it("notify listeners of remote changes", async () => {
    const a = client(laptop);
    const b = client(phone);
    const changes: DocumentChange[] = [];
    b.client.onChange((change) => changes.push(change));
    a.client.set("notes", "n1", { title: "hello", color: "green" });
    await a.client.sync();
    await b.client.sync();
    expect(changes).toEqual([
      { collection: "notes", id: "n1", fields: { title: "hello", color: "green" }, changedFields: ["color", "title"], source: "remote" },
    ]);
  });

  it("keep their data, outbox and cursor across a restart", async () => {
    const dbPath = tempDbPath();
    const clock = new ManualClock(server.clock.now());
    const b = client(phone);
    b.client.set("notes", "n1", { title: "from phone" });
    await b.client.sync();

    const first = openClient(server, laptop, { dbPath, clock });
    await first.client.sync();
    first.client.set("tasks", "t1", { title: "offline write" });
    const cursor = first.client.pullCursor();
    await first.client.close();

    const again = client(laptop, { dbPath, clock });
    expect(again.client.pendingCount()).toBe(1);
    expect(again.client.pullCursor()).toBe(cursor);
    expect(again.client.get("notes", "n1")?.fields).toEqual({ title: "from phone" });
    expect(await again.client.sync()).toEqual({ pushed: 1, pulled: 1, applied: 0 });
  });

  it("never see another user's writes", async () => {
    const other = await server.createUser("Grace");
    const a = client(laptop);
    const g = client(other);
    g.client.set("notes", "n1", { title: "Grace's note" });
    await g.client.sync();
    expect(await a.client.sync()).toEqual({ pushed: 0, pulled: 0, applied: 0 });
    expect(a.client.get("notes", "n1")).toBeNull();
  });
});
