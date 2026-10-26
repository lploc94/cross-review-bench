import { CollectionNotKeptError } from "@sync/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openClient, type TestClient } from "../helpers/clients.js";
import { tempDbPath } from "../helpers/tempFiles.js";
import { startTestServer, type TestAccount, type TestServer } from "../helpers/testServer.js";

let server: TestServer;
let laptop: TestAccount;
let phone: TestAccount;
let full: TestClient;
const opened: TestClient[] = [];

function open(account: TestAccount, options: Parameters<typeof openClient>[2] = {}): TestClient {
  const c = openClient(server, account, options);
  opened.push(c);
  return c;
}

async function closeClient(c: TestClient): Promise<void> {
  opened.splice(opened.indexOf(c), 1);
  await c.client.close();
}

beforeEach(async () => {
  server = await startTestServer();
  laptop = await server.createUser("Ada");
  phone = await server.addDevice(laptop);
  full = open(laptop);
});

afterEach(async () => {
  for (const c of opened.splice(0)) await c.client.close();
  await server.close();
});

/** Interleaved writes on the full replica: `count` notes and `count` tasks. */
async function writeBoth(count: number, from = 0): Promise<void> {
  for (let i = from; i < from + count; i++) {
    full.clock.advance(1);
    full.client.set("notes", `n${i}`, { title: `Note ${i}` });
    full.client.set("tasks", `t${i}`, { title: `Task ${i}`, priority: i % 4 });
  }
  await full.client.sync();
}

describe("replicas of some collections against the server", () => {
  it("receive every event of their collections across pages and none of the others", async () => {
    await writeBoth(5);
    const notesOnly = open(phone, { collections: ["notes"], pullLimit: 2 });
    await notesOnly.client.sync();
    expect(notesOnly.client.list("notes")).toEqual(full.client.list("notes"));
    expect(() => notesOnly.client.list("tasks")).toThrow(CollectionNotKeptError);
    expect(notesOnly.client.pullCursor()).toBe(full.client.pullCursor());

    await writeBoth(2, 5);
    await notesOnly.client.sync();
    expect(notesOnly.client.list("notes")).toHaveLength(7);
    expect(notesOnly.client.list("notes")).toEqual(full.client.list("notes"));
  });

  it("re-pull an added collection completely, after an interrupted attempt and later writes", async () => {
    await writeBoth(4);
    const dbPath = tempDbPath();
    const notesOnly = open(phone, { dbPath, collections: ["notes"], pullLimit: 2 });
    await notesOnly.client.sync();
    await closeClient(notesOnly);

    const both = open(phone, { dbPath, collections: ["notes", "tasks"], pullLimit: 2 });
    await writeBoth(2, 4);
    await both.client.sync();
    expect(() => both.client.get("tasks", "t0")).toThrow(/resync/);

    both.transport.failNext();
    await expect(both.client.resync()).rejects.toMatchObject({ retryable: true });
    expect(both.client.collections().pending).toEqual(["tasks"]);
    await both.client.resync();
    expect(both.client.collections()).toEqual({ kept: ["notes", "tasks"], pending: [] });
    expect(both.client.list("tasks")).toEqual(full.client.list("tasks"));
    expect(both.client.list("notes")).toEqual(full.client.list("notes"));

    await writeBoth(1, 6);
    await both.client.sync();
    expect(both.client.list("tasks")).toEqual(full.client.list("tasks"));
  });

  it("rebuild a collection that was left out and added again, keeping writes made before", async () => {
    const dbPath = tempDbPath();
    const first = open(phone, { dbPath, pullLimit: 3 });
    first.client.set("notes", "mine", { title: "Unpushed" });
    await closeClient(first);
    await writeBoth(3);

    const tasksOnly = open(phone, { dbPath, collections: ["tasks"], pullLimit: 3 });
    expect(tasksOnly.client.pendingCount()).toBe(1);
    await tasksOnly.client.sync();
    expect(tasksOnly.client.pendingCount()).toBe(0);
    await closeClient(tasksOnly);

    await full.client.sync();
    expect(full.client.get("notes", "mine")?.fields).toEqual({ title: "Unpushed" });
    const again = open(phone, { dbPath, collections: ["notes", "tasks"], pullLimit: 3 });
    await again.client.resync();
    expect(again.client.list("notes")).toEqual(full.client.list("notes"));
    expect(again.client.list("tasks")).toEqual(full.client.list("tasks"));
  });
});
