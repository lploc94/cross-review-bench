import { ClientClosedError, SyncClient, type DocumentChange } from "@sync/client";
import { ManualClock, MutationValidationError, compareHlcStrings, parseHlc, seededRandom } from "@sync/shared";
import { describe, expect, it } from "vitest";
import { openLocalClient, unreachableTransport } from "../helpers/clients.js";
import { tempDbPath } from "../helpers/tempFiles.js";

describe("SyncClient local writes", () => {
  it("apply at once and wait in the outbox", async () => {
    const client = openLocalClient();
    const mutation = client.set("notes", "n1", { title: "Groceries", tags: ["home"] });
    expect(client.get("notes", "n1")).toEqual({
      collection: "notes",
      id: "n1",
      fields: { title: "Groceries", tags: ["home"] },
    });
    expect(mutation).toMatchObject({ collection: "notes", docId: "n1", op: "set", fields: { title: "Groceries" } });
    expect(client.pendingCount()).toBe(1);
    await client.close();
  });

  it("merge later writes into the document", async () => {
    const client = openLocalClient();
    client.set("tasks", "t1", { title: "Call", priority: 1 });
    client.set("tasks", "t1", { priority: 3, done: true });
    expect(client.get("tasks", "t1")?.fields).toEqual({ title: "Call", priority: 3, done: true });
    expect(client.pendingCount()).toBe(2);
    await client.close();
  });

  it("stamp each write with a greater timestamp, even within one millisecond", async () => {
    const client = openLocalClient();
    const a = client.set("notes", "n1", { title: "a" });
    const b = client.set("notes", "n1", { title: "b" });
    expect(compareHlcStrings(b.hlc, a.hlc)).toBe(1);
    expect(parseHlc(b.hlc).node).toBe(client.nodeId);
    await client.close();
  });

  it("reject invalid writes without changing anything", async () => {
    const client = openLocalClient();
    const bad: [string, string, Record<string, unknown>][] = [
      ["contacts", "c1", { title: "x" }],
      ["notes", "bad id", { title: "x" }],
      ["notes", "n1", {}],
      ["notes", "n1", { pinned: "yes" }],
      ["notes", "n1", { owner: "me" }],
    ];
    for (const [collection, id, fields] of bad) {
      expect(() => client.set(collection as "notes", id, fields), `${collection}/${id}`).toThrow(MutationValidationError);
    }
    expect(client.pendingCount()).toBe(0);
    expect(client.list("notes")).toEqual([]);
    await client.close();
  });

  it("apply all writes of setMany or none", async () => {
    const client = openLocalClient();
    expect(() =>
      client.setMany([
        { collection: "notes", id: "n1", fields: { title: "ok" } },
        { collection: "tasks", id: "t1", fields: { priority: 9 } },
      ]),
    ).toThrow(MutationValidationError);
    expect(client.pendingCount()).toBe(0);
    const mutations = client.setMany([
      { collection: "notes", id: "n1", fields: { title: "one" } },
      { collection: "notes", id: "n1", fields: { title: "two" } },
      { collection: "tasks", id: "t1", fields: { done: false } },
    ]);
    expect(mutations).toHaveLength(3);
    expect(client.get("notes", "n1")?.fields.title).toBe("two");
    expect(client.pendingCount()).toBe(3);
    await client.close();
  });

  it("list documents by id, all or by page", async () => {
    const client = openLocalClient();
    for (const id of ["c", "a", "b"]) client.set("notes", id, { title: id.toUpperCase() });
    client.set("tasks", "a", { title: "task" });
    expect(client.list("notes").map((d) => d.id)).toEqual(["a", "b", "c"]);
    expect(client.list("notes", { limit: 2 }).map((d) => d.id)).toEqual(["a", "b"]);
    expect(client.list("notes", { limit: 2, afterId: "b" }).map((d) => d.id)).toEqual(["c"]);
    expect(() => client.list("notes", { limit: 0 })).toThrow(RangeError);
    await client.close();
  });

  it("tell listeners about committed changes", async () => {
    const client = openLocalClient();
    const seen: DocumentChange[] = [];
    const unsubscribe = client.onChange((change) => seen.push(change));
    client.set("notes", "n1", { title: "x", pinned: true });
    unsubscribe();
    client.set("notes", "n1", { title: "y" });
    expect(seen).toEqual([
      {
        collection: "notes",
        id: "n1",
        fields: { title: "x", pinned: true },
        changedFields: ["pinned", "title"],
        source: "local",
      },
    ]);
    await client.close();
  });

  it("keep calling listeners when one throws, and report its error", async () => {
    const errors: unknown[] = [];
    const client = openLocalClient({ onListenerError: (err) => errors.push(err) });
    let called = 0;
    client.onChange(() => {
      throw new Error("listener bug");
    });
    client.onChange(() => {
      called += 1;
    });
    client.set("notes", "n1", { title: "x" });
    expect(called).toBe(1);
    expect(errors).toHaveLength(1);
    expect(client.get("notes", "n1")).not.toBeNull();
    await client.close();
  });

  it("refuse to work once closed", async () => {
    const client = openLocalClient();
    await client.close();
    expect(() => client.set("notes", "n1", { title: "x" })).toThrow(ClientClosedError);
    expect(() => client.get("notes", "n1")).toThrow(ClientClosedError);
    await expect(client.sync()).rejects.toBeInstanceOf(ClientClosedError);
    await client.close();
  });
});

describe("SyncClient identity and clock across restarts", () => {
  it("keeps the node id chosen when the database was created", async () => {
    const dbPath = tempDbPath();
    const first = SyncClient.open({ dbPath, transport: unreachableTransport, clock: new ManualClock(), random: seededRandom(1) });
    const nodeId = first.nodeId;
    await first.close();
    const again = SyncClient.open({ dbPath, transport: unreachableTransport, clock: new ManualClock(), random: seededRandom(2) });
    expect(again.nodeId).toBe(nodeId);
    await again.close();
  });

  it("refuses a node id that is not the database's", async () => {
    const dbPath = tempDbPath();
    const first = SyncClient.open({ dbPath, transport: unreachableTransport, clock: new ManualClock(), nodeId: "laptop-1" });
    await first.close();
    expect(() =>
      SyncClient.open({ dbPath, transport: unreachableTransport, clock: new ManualClock(), nodeId: "laptop-2" }),
    ).toThrow(/belongs to node laptop-1/);
    const same = SyncClient.open({ dbPath, transport: unreachableTransport, clock: new ManualClock(), nodeId: "laptop-1" });
    await same.close();
  });

  it("continues after the last stored timestamp when the clock went back", async () => {
    const dbPath = tempDbPath();
    const clock = new ManualClock();
    const first = SyncClient.open({ dbPath, transport: unreachableTransport, clock });
    const before = first.set("notes", "n1", { title: "before" });
    await first.close();
    clock.advance(-3_600_000);
    const again = SyncClient.open({ dbPath, transport: unreachableTransport, clock });
    const after = again.set("notes", "n1", { title: "after" });
    expect(compareHlcStrings(after.hlc, before.hlc)).toBe(1);
    expect(again.get("notes", "n1")?.fields.title).toBe("after");
    await again.close();
  });

  it("uses the physical clock when it is ahead of the stored timestamp", async () => {
    const dbPath = tempDbPath();
    const clock = new ManualClock();
    const first = SyncClient.open({ dbPath, transport: unreachableTransport, clock });
    first.set("notes", "n1", { title: "before" });
    await first.close();
    clock.advance(10_000);
    const again = SyncClient.open({ dbPath, transport: unreachableTransport, clock });
    expect(parseHlc(again.set("notes", "n1", { title: "after" }).hlc)).toMatchObject({ wallMs: clock.now(), counter: 0 });
    await again.close();
  });

  it("validates its options", () => {
    const base = { dbPath: ":memory:", transport: unreachableTransport, clock: new ManualClock() };
    expect(() => SyncClient.open({ ...base, pushBatchSize: 0 })).toThrow(RangeError);
    expect(() => SyncClient.open({ ...base, pullLimit: 1_001 })).toThrow(RangeError);
    expect(() => SyncClient.open({ ...base, nodeId: "Bad Node" })).toThrow(RangeError);
  });
});
