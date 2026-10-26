import { compareHlcStrings, parseHlc, type PushResponse } from "@sync/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildTestApp, type TestApp } from "../helpers/app.js";
import { addDevice, createUser, hlc, mutation, push, type TestDevice } from "../helpers/fixtures.js";

let t: TestApp;
let ada: TestDevice;
let now: number;

beforeEach(async () => {
  t = await buildTestApp();
  ada = await createUser(t);
  now = t.clock.now();
});

afterEach(async () => {
  await t.close();
});

async function events(userId = ada.userId) {
  const result = await t.pool.query<{ seq: string; mutation_id: string; doc_id: string; field: string; value: unknown; hlc: string }>(
    "SELECT seq, mutation_id, doc_id, field, value, hlc FROM events WHERE user_id = $1 ORDER BY seq",
    [userId],
  );
  return result.rows;
}

async function document(docId = "note-1", userId = ada.userId) {
  const result = await t.pool.query<{ fields: Record<string, unknown>; field_hlcs: Record<string, string>; updated_seq: string }>(
    "SELECT fields, field_hlcs, updated_seq FROM documents WHERE user_id = $1 AND collection = 'notes' AND doc_id = $2",
    [userId, docId],
  );
  return result.rows[0];
}

describe("POST /v1/sync/push", () => {
  it("applies a new document and acknowledges the mutation", async () => {
    const m = mutation({ hlc: hlc(now - 1000), fields: { title: "Groceries", tags: ["home"], pinned: true } });
    const res = await push(t, ada, [m]);
    expect(res.statusCode).toBe(200);
    expect(res.json<PushResponse>().acked).toEqual([m.mutationId]);
    expect(await document()).toEqual({
      fields: { title: "Groceries", tags: ["home"], pinned: true },
      field_hlcs: { title: m.hlc, tags: m.hlc, pinned: m.hlc },
      updated_seq: "3",
    });
    expect((await events()).map((e) => [e.field, e.value])).toEqual([
      ["pinned", true],
      ["tags", ["home"]],
      ["title", "Groceries"],
    ]);
  });

  it("answers the server clock, ahead of every received timestamp", async () => {
    const ahead = hlc(now + 5_000, 7);
    const res = await push(t, ada, [mutation({ hlc: ahead })]);
    const serverHlc = res.json<{ serverHlc: string }>().serverHlc;
    expect(compareHlcStrings(serverHlc, ahead)).toBe(1);
    expect(parseHlc(serverHlc).node).toBe("server");
  });

  it("keeps the newer value of each field whatever the arrival order", async () => {
    const newer = mutation({ hlc: hlc(now - 100), fields: { title: "Newer" } });
    const older = mutation({ hlc: hlc(now - 200), fields: { title: "Older", body: "only the body is new" } });
    await push(t, ada, [newer]);
    const res = await push(t, ada, [older]);
    expect(res.json<PushResponse>().acked).toEqual([older.mutationId]);
    expect((await document())?.fields).toEqual({ title: "Newer", body: "only the body is new" });
    // The losing write leaves no event.
    expect((await events()).map((e) => [e.field, e.mutation_id])).toEqual([
      ["title", newer.mutationId],
      ["body", older.mutationId],
    ]);
  });

  it("breaks equal wall times by counter, then by node id", async () => {
    await push(t, ada, [mutation({ hlc: hlc(now, 1, "node-b"), fields: { title: "b" } })]);
    await push(t, ada, [mutation({ hlc: hlc(now, 1, "node-a"), fields: { title: "a" } })]);
    expect((await document())?.fields.title).toBe("b");
    await push(t, ada, [mutation({ hlc: hlc(now, 2, "node-a"), fields: { title: "a2" } })]);
    expect((await document())?.fields.title).toBe("a2");
  });

  it("orders writes of one request by timestamp, not by position", async () => {
    const res = await push(t, ada, [
      mutation({ hlc: hlc(now - 10), fields: { title: "second" } }),
      mutation({ hlc: hlc(now - 20), fields: { title: "first" } }),
    ]);
    expect(res.statusCode).toBe(200);
    expect((await document())?.fields.title).toBe("second");
    expect(await events()).toHaveLength(1);
  });

  it("acknowledges a mutation pushed again without applying it twice", async () => {
    const m = mutation({ hlc: hlc(now - 1000), fields: { title: "Once" } });
    await push(t, ada, [m]);
    const later = mutation({ hlc: hlc(now - 500), fields: { title: "Later" } });
    await push(t, ada, [later]);
    const again = await push(t, ada, [m]);
    expect(again.statusCode).toBe(200);
    expect(again.json<PushResponse>().acked).toEqual([m.mutationId]);
    expect(await events()).toHaveLength(2);
    expect((await document())?.fields.title).toBe("Later");
  });

  it("acknowledges a retried mutation sent from another device of the user", async () => {
    const phone = await addDevice(t, ada);
    const m = mutation({ hlc: hlc(now - 1000) });
    await push(t, ada, [m]);
    const res = await push(t, phone, [m]);
    expect(res.json<PushResponse>().acked).toEqual([m.mutationId]);
    expect(await events()).toHaveLength(1);
  });

  it("keeps mutation ids of different users apart", async () => {
    const grace = await createUser(t, "Grace");
    const m = mutation({ hlc: hlc(now - 1000) });
    await push(t, ada, [m]);
    await push(t, grace, [m]);
    expect(await events(ada.userId)).toHaveLength(1);
    expect(await events(grace.userId)).toHaveLength(1);
  });

  it("applies the same mutation once when two pushes race", async () => {
    const m = mutation({ hlc: hlc(now - 1000) });
    const answers = await Promise.all([push(t, ada, [m]), push(t, ada, [m])]);
    expect(answers.map((res) => res.statusCode)).toEqual([200, 200]);
    expect(await events()).toHaveLength(1);
  });

  it("numbers the events of concurrent pushes in commit order", async () => {
    const batches = Array.from({ length: 4 }, (_, i) =>
      Array.from({ length: 5 }, (_, j) => mutation({ docId: `doc-${i}-${j}`, hlc: hlc(now - 1000 + i) })),
    );
    await Promise.all(batches.map((batch) => push(t, ada, batch)));
    const rows = await events();
    expect(rows).toHaveLength(20);
    // Each request's events are contiguous: no other request committed in between.
    const requestOf = (docId: string) => docId.split("-")[1];
    const runs = rows.map((r) => requestOf(r.doc_id)).filter((r, i, all) => i === 0 || all[i - 1] !== r);
    expect(runs).toHaveLength(4);
  });

  it("rejects the whole request when one mutation has an unknown collection", async () => {
    const res = await push(t, ada, [
      mutation({ hlc: hlc(now - 10) }),
      mutation({ hlc: hlc(now - 5), collection: "contacts" }),
    ]);
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ error: { code: "invalid_mutation", details: { index: 1 } } });
    expect(await events()).toHaveLength(0);
    expect(await document()).toBeUndefined();
  });

  it("names the mutation and field of a value of the wrong type", async () => {
    const bad = mutation({ hlc: hlc(now), fields: { title: "ok", pinned: "yes" } });
    const res = await push(t, ada, [mutation({ hlc: hlc(now - 1) }), mutation({ hlc: hlc(now - 2) }), bad]);
    expect(res.statusCode).toBe(422);
    const body = res.json<{ error: { details: { index: number; mutationId: string; issues: { field: string }[] } } }>();
    expect(body.error.details.index).toBe(2);
    expect(body.error.details.mutationId).toBe(bad.mutationId);
    expect(body.error.details.issues.map((i) => i.field)).toEqual(["pinned"]);
    expect(await events()).toHaveLength(0);
  });

  it("rejects unknown fields, empty writes and impossible dates", async () => {
    const cases = [
      mutation({ hlc: hlc(now), fields: { colour: "red" } }),
      mutation({ hlc: hlc(now), fields: {} }),
      mutation({ hlc: hlc(now), collection: "tasks", fields: { dueDate: "2030-02-30" } }),
      mutation({ hlc: hlc(now), fields: { title: "nul \u0000 inside" } }),
    ];
    for (const m of cases) {
      expect((await push(t, ada, [m])).statusCode).toBe(422);
    }
  });

  it("rejects a request that repeats a mutation id", async () => {
    const m = mutation({ hlc: hlc(now) });
    const res = await push(t, ada, [m, { ...m, hlc: hlc(now + 1) }]);
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ error: { details: { index: 1 } } });
  });

  it("rejects malformed envelopes with 400", async () => {
    const valid = mutation({ hlc: hlc(now) });
    const cases: unknown[] = [
      [],
      [{ ...valid, op: "delete" }],
      [{ ...valid, mutationId: valid.mutationId.toUpperCase() }],
      [{ ...valid, hlc: "yesterday" }],
      [{ ...valid, docId: "has space" }],
      [{ ...valid, extra: true }],
    ];
    for (const mutations of cases) {
      const res = await push(t, ada, mutations);
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ error: { code: "validation_error" } });
    }
  });

  it("limits the mutations of one request", async () => {
    const small = await buildTestApp({ env: { PUSH_MAX_MUTATIONS: "2" } });
    try {
      const res = await push(small, ada, [1, 2, 3].map((i) => mutation({ docId: `n${i}`, hlc: hlc(now) })));
      expect(res.statusCode).toBe(400);
    } finally {
      await small.close();
    }
  });

  it("refuses timestamps too far ahead of the server clock", async () => {
    const res = await push(t, ada, [mutation({ hlc: hlc(now - 1) }), mutation({ hlc: hlc(now + 60_001) })]);
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ error: { code: "clock_drift", details: { index: 1, maxDriftMs: 60_000 } } });
    expect(await events()).toHaveLength(0);
  });

  it("accepts a timestamp exactly at the drift limit", async () => {
    expect((await push(t, ada, [mutation({ hlc: hlc(now + 60_000) })])).statusCode).toBe(200);
  });

  it("records the last event's seq on the document", async () => {
    await push(t, ada, [mutation({ hlc: hlc(now - 10), fields: { title: "a", body: "b" } })]);
    await push(t, ada, [mutation({ docId: "other", hlc: hlc(now - 9) })]);
    await push(t, ada, [mutation({ hlc: hlc(now - 8), fields: { body: "c" } })]);
    expect((await document())?.updated_seq).toBe("4");
  });

  it("stores every mutation it acknowledged", async () => {
    const m = mutation({ hlc: hlc(now - 10) });
    const loser = mutation({ hlc: hlc(now - 20) });
    await push(t, ada, [m, loser]);
    const rows = await t.pool.query("SELECT mutation_id FROM mutations WHERE user_id = $1 ORDER BY mutation_id", [ada.userId]);
    expect(rows.rows.map((r: { mutation_id: string }) => r.mutation_id).sort()).toEqual([m.mutationId, loser.mutationId].sort());
  });

  it("refuses a body over the configured limit", async () => {
    const small = await buildTestApp({ env: { BODY_LIMIT_BYTES: "2048" } });
    try {
      const big = mutation({ hlc: hlc(now), fields: { body: "x".repeat(4000) } });
      const res = await push(small, ada, [big]);
      expect(res.statusCode).toBe(413);
      expect(res.json()).toMatchObject({ error: { code: "payload_too_large" } });
    } finally {
      await small.close();
    }
  });
});
