import { setTimeout as delay } from "node:timers/promises";
import type { LightMyRequestResponse } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildTestApp, type TestApp } from "../helpers/app.js";
import { createUser, hlc, mutation, push, type TestDevice } from "../helpers/fixtures.js";

let t: TestApp;
let ada: TestDevice;
let grace: TestDevice;

beforeEach(async () => {
  t = await buildTestApp();
  ada = await createUser(t);
  grace = await createUser(t, "Grace");
});

afterEach(async () => {
  await t.close();
});

interface ChangedDocument {
  collection: string;
  id: string;
  fields: Record<string, unknown>;
  fieldHlcs: Record<string, string>;
  updatedSeq: number;
}

interface ChangesPage {
  documents: ChangedDocument[];
  nextAfter: number;
  hasMore: boolean;
}

/** A reader that pages through the changes and keeps the newest state it saw of each document. */
class Reader {
  after = 0;
  readonly seen = new Map<string, ChangedDocument>();

  constructor(private readonly device: TestDevice) {}

  async page(limit: number): Promise<ChangesPage> {
    const res = await t.app.inject({
      method: "GET",
      url: `/v1/documents/changes?after=${this.after}&limit=${limit}`,
      headers: { authorization: `Bearer ${this.device.token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<ChangesPage>();
    let previous = this.after;
    for (const doc of body.documents) {
      expect(doc.updatedSeq).toBeGreaterThan(previous);
      previous = doc.updatedSeq;
      const { collection, id, fields, fieldHlcs, updatedSeq } = doc;
      this.seen.set(`${collection}/${id}`, { collection, id, fields, fieldHlcs, updatedSeq });
    }
    this.after = body.nextAfter;
    return body;
  }

  async drain(limit: number): Promise<void> {
    for (let i = 0; i < 1_000; i++) {
      if (!(await this.page(limit)).hasMore) return;
    }
    throw new Error("changes never ran out");
  }
}

async function storedDocuments(device: TestDevice): Promise<Map<string, ChangedDocument>> {
  const result = await t.pool.query<{
    collection: string;
    doc_id: string;
    fields: Record<string, unknown>;
    field_hlcs: Record<string, string>;
    updated_seq: string;
  }>("SELECT collection, doc_id, fields, field_hlcs, updated_seq FROM documents WHERE user_id = $1", [
    device.userId,
  ]);
  return new Map(
    result.rows.map((row) => [
      `${row.collection}/${row.doc_id}`,
      {
        collection: row.collection,
        id: row.doc_id,
        fields: row.fields,
        fieldHlcs: row.field_hlcs,
        updatedSeq: Number(row.updated_seq),
      },
    ]),
  );
}

let step = 0;

async function setTitle(device: TestDevice, docId: string, title: string, collection = "notes"): Promise<void> {
  step += 1;
  t.clock.advance(1);
  const res = await push(t, device, [
    mutation({ collection, docId, hlc: hlc(t.clock.now(), 0, `node-${step}`), fields: { title } }),
  ]);
  expect(res.statusCode).toBe(200);
}

/** Wait until some session of this database waits for a lock. */
async function untilBlocked(): Promise<void> {
  for (let i = 0; i < 2_000; i++) {
    const result = await t.pool.query<{ waiting: string }>(
      `SELECT count(*) AS waiting FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock'`,
    );
    if (Number(result.rows[0]?.waiting ?? 0) > 0) return;
    await delay(5);
  }
  throw new Error("the push never waited for the user's lock");
}

describe("paging through changed documents while pushes run", () => {
  it("returns a push that waited for the user's lock after a reader passed later seqs", async () => {
    for (const id of ["a", "b", "c", "d"]) await setTitle(ada, id, `${id}1`);
    const reader = new Reader(ada);
    expect((await reader.page(2)).hasMore).toBe(true);

    // Hold Ada's user row, as a push in progress does, so her next push waits before it writes.
    const holder = await t.pool.connect();
    let pending: Promise<LightMyRequestResponse> | undefined;
    let held = false;
    try {
      await holder.query("BEGIN");
      held = true;
      await holder.query("SELECT id FROM users WHERE id = $1 FOR UPDATE", [ada.userId]);
      step += 1;
      t.clock.advance(1);
      pending = push(t, ada, [
        mutation({ docId: "a", hlc: hlc(t.clock.now(), 0, "late"), fields: { title: "a2" } }),
        mutation({ docId: "e", hlc: hlc(t.clock.now(), 1, "late"), fields: { title: "e1" } }),
      ]);
      await untilBlocked();
      // Other users' pushes take sequence numbers meanwhile.
      await setTitle(grace, "g", "g1");
      await setTitle(grace, "h", "h1");
      await reader.drain(2);
      expect([...reader.seen.keys()].sort()).toEqual(["notes/a", "notes/b", "notes/c", "notes/d"]);
      await holder.query("COMMIT");
      held = false;
    } finally {
      if (held) await holder.query("ROLLBACK");
      holder.release();
    }
    const res = await pending;
    expect(res.statusCode).toBe(200);

    await reader.drain(2);
    expect(reader.seen).toEqual(await storedDocuments(ada));
    expect(reader.seen.get("notes/a")?.fields.title).toBe("a2");
    expect(reader.seen.get("notes/e")?.fields.title).toBe("e1");
  });

  it("ends with every document at its latest state when pages and pushes interleave", async () => {
    const ids = ["n1", "n2", "n3", "n4", "n5", "n6", "n7"];
    for (const id of ids) await setTitle(ada, id, `${id}-v0`);
    const reader = new Reader(ada);
    // A fixed interleaving: after each page, rewrite one document already listed, one not yet
    // listed, and add a new one; another user writes too.
    for (let round = 1; round <= 6; round++) {
      await reader.page(2);
      const listed = [...reader.seen.keys()].map((key) => key.slice("notes/".length));
      const target = listed[round % listed.length] ?? "n1";
      await setTitle(ada, target, `${target}-v${round}`);
      const unlisted = ids.find((id) => !reader.seen.has(`notes/${id}`));
      if (unlisted) await setTitle(ada, unlisted, `${unlisted}-v${round}`);
      const added = `x${round}`;
      ids.push(added);
      await setTitle(ada, added, `${added}-v${round}`, round % 2 === 0 ? "tasks" : "notes");
      await setTitle(grace, `g${round}`, `g${round}`);
    }
    await reader.drain(3);
    const stored = await storedDocuments(ada);
    expect(stored.size).toBe(ids.length);
    expect(reader.seen).toEqual(stored);
  });

  it("pages exactly once through documents that do not change", async () => {
    for (let i = 0; i < 9; i++) await setTitle(i % 2 === 0 ? ada : grace, `s${i}`, `s${i}`);
    const seen: string[] = [];
    let after = 0;
    for (let i = 0; i < 20; i++) {
      const res = await t.app.inject({
        method: "GET",
        url: `/v1/documents/changes?after=${after}&limit=2`,
        headers: { authorization: `Bearer ${ada.token}` },
      });
      const body = res.json<ChangesPage>();
      seen.push(...body.documents.map((d) => d.id));
      after = body.nextAfter;
      if (!body.hasMore) break;
    }
    expect(seen).toEqual(["s0", "s2", "s4", "s6", "s8"]);
  });
});
