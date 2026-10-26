import { CorruptStoreError, IN_MEMORY, META_KEYS, migrate, openDatabase } from "@sync/client";
import { formatHlc, type Mutation } from "@sync/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DocsStore } from "../../src/store/docsStore.js";
import { MetaStore } from "../../src/store/metaStore.js";
import { OutboxStore } from "../../src/store/outboxStore.js";

let db: ReturnType<typeof openDatabase>;

beforeEach(() => {
  db = openDatabase(IN_MEMORY);
  migrate(db);
});

afterEach(() => {
  db.close();
});

const hlc = formatHlc({ wallMs: 1_894_701_600_000, counter: 0, node: "n1" });

function mutation(n: number): Mutation {
  return {
    mutationId: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
    collection: "notes",
    docId: `note-${n}`,
    op: "set",
    fields: { title: `Note ${n}`, tags: ["a"] },
    hlc,
  };
}

describe("OutboxStore", () => {
  it("returns mutations in the order they were queued, in batches", () => {
    const outbox = new OutboxStore(db);
    for (let n = 1; n <= 5; n++) outbox.append(mutation(n));
    const first = outbox.batchAfter(0, 2);
    expect(first.map((e) => e.mutation.docId)).toEqual(["note-1", "note-2"]);
    expect(first[0]?.mutation).toEqual(mutation(1));
    const next = outbox.batchAfter(first[1]?.seq ?? 0, 10);
    expect(next.map((e) => e.mutation.docId)).toEqual(["note-3", "note-4", "note-5"]);
  });

  it("removes acknowledged mutations only", () => {
    const outbox = new OutboxStore(db);
    for (let n = 1; n <= 3; n++) outbox.append(mutation(n));
    expect(outbox.remove([mutation(1).mutationId, mutation(3).mutationId, mutation(9).mutationId])).toBe(2);
    expect(outbox.batchAfter(0, 10).map((e) => e.mutation.docId)).toEqual(["note-2"]);
    expect(outbox.count()).toBe(1);
  });

  it("never reuses a seq after the newest entry is removed", () => {
    const outbox = new OutboxStore(db);
    const first = outbox.append(mutation(1));
    outbox.remove([mutation(1).mutationId]);
    expect(outbox.append(mutation(2))).toBeGreaterThan(first);
  });

  it("counts failures and keeps a bounded error message", () => {
    const outbox = new OutboxStore(db);
    const seq = outbox.append(mutation(1));
    outbox.recordFailure([seq], "network down");
    outbox.recordFailure([seq], "x".repeat(2_000));
    const [entry] = outbox.batchAfter(0, 1);
    expect(entry?.attempts).toBe(2);
    expect(entry?.lastError).toHaveLength(500);
  });

  it("refuses the same mutation twice", () => {
    const outbox = new OutboxStore(db);
    outbox.append(mutation(1));
    expect(() => outbox.append(mutation(1))).toThrow(/UNIQUE/);
  });
});

describe("DocsStore", () => {
  it("stores, replaces and lists documents by id", () => {
    const docs = new DocsStore(db);
    docs.put("notes", "b", { fields: { title: "B" }, fieldHlcs: { title: hlc } });
    docs.put("notes", "a", { fields: { title: "A" }, fieldHlcs: { title: hlc } });
    docs.put("tasks", "a", { fields: { done: true }, fieldHlcs: { done: hlc } });
    docs.put("notes", "b", { fields: { title: "B2" }, fieldHlcs: { title: hlc } });
    expect(docs.list("notes").map((d) => [d.id, d.fields.title])).toEqual([
      ["a", "A"],
      ["b", "B2"],
    ]);
    expect(docs.get("tasks", "a")?.fields).toEqual({ done: true });
    expect(docs.get("tasks", "b")).toBeNull();
    expect(docs.count("notes")).toBe(2);
  });

  it("pages by id", () => {
    const docs = new DocsStore(db);
    for (const id of ["d", "a", "c", "b"]) docs.put("notes", id, { fields: {}, fieldHlcs: {} });
    expect(docs.listPage("notes", null, 2).map((d) => d.id)).toEqual(["a", "b"]);
    expect(docs.listPage("notes", "b", 2).map((d) => d.id)).toEqual(["c", "d"]);
    expect(docs.listPage("notes", "d", 2)).toEqual([]);
  });

  it("reports a corrupt row instead of returning it", () => {
    db.prepare("INSERT INTO docs (collection, id, fields, field_hlcs) VALUES ('notes', 'bad', '[1]', '{}')").run();
    expect(() => new DocsStore(db).get("notes", "bad")).toThrow(CorruptStoreError);
  });
});

describe("MetaStore", () => {
  it("starts with no cursor, no HLC and no node id", () => {
    const meta = new MetaStore(db);
    expect(meta.pullAfter()).toBe(0);
    expect(meta.lastHlc()).toBeNull();
    expect(meta.nodeId()).toBeNull();
  });

  it("round-trips its values", () => {
    const meta = new MetaStore(db);
    meta.setPullAfter(42);
    meta.setLastHlc({ wallMs: 5, counter: 1, node: "n1" });
    meta.setNodeId("abc123");
    expect(meta.pullAfter()).toBe(42);
    expect(meta.lastHlc()).toEqual({ wallMs: 5, counter: 1, node: "n1" });
    expect(meta.nodeId()).toBe("abc123");
  });

  it("reports corrupt values", () => {
    const meta = new MetaStore(db);
    meta.set(META_KEYS.pullAfter, "-3");
    expect(() => meta.pullAfter()).toThrow(CorruptStoreError);
    meta.set(META_KEYS.lastHlc, "yesterday");
    expect(() => meta.lastHlc()).toThrow(CorruptStoreError);
    meta.set(META_KEYS.nodeId, "Not Valid");
    expect(() => meta.nodeId()).toThrow(CorruptStoreError);
  });

  it("refuses to store an invalid cursor", () => {
    expect(() => new MetaStore(db).setPullAfter(-1)).toThrow(RangeError);
  });
});
