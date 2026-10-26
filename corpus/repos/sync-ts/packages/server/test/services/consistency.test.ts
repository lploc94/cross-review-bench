import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConsistencyService } from "../../src/services/consistencyService.js";
import { StatsService } from "../../src/services/statsService.js";
import { buildTestApp, type TestApp } from "../helpers/app.js";
import { addDevice, createUser, hlc, mutation, pull, push, type TestDevice } from "../helpers/fixtures.js";

let t: TestApp;
let ada: TestDevice;
let verifier: ConsistencyService;

beforeEach(async () => {
  t = await buildTestApp();
  ada = await createUser(t);
  // A small page size makes the replay cross page boundaries.
  verifier = new ConsistencyService({ pool: t.pool, pageSize: 2 });
  const now = t.clock.now();
  await push(t, ada, [
    mutation({ hlc: hlc(now - 30), fields: { title: "One", body: "first" } }),
    mutation({ docId: "note-2", hlc: hlc(now - 20), fields: { title: "Two", tags: ["a", "b"] } }),
  ]);
  await push(t, ada, [mutation({ hlc: hlc(now - 10), fields: { title: "One, edited" } })]);
});

afterEach(async () => {
  await t.close();
});

describe("ConsistencyService", () => {
  it("finds nothing wrong after normal pushes", async () => {
    const report = await verifier.verifyUser(ada.userId);
    expect(report).toEqual({ userId: ada.userId, events: 5, documents: 2, problems: [], truncated: false });
  });

  it("reports a document whose field disagrees with the events", async () => {
    await t.pool.query(
      `UPDATE documents SET fields = jsonb_set(fields, '{title}', '"tampered"') WHERE doc_id = 'note-1'`,
    );
    const report = await verifier.verifyUser(ada.userId);
    expect(report.problems).toEqual([{ kind: "field_mismatch", doc: "notes/note-1", field: "title" }]);
  });

  it("reports missing and unexpected documents and a wrong updated_seq", async () => {
    await t.pool.query("DELETE FROM documents WHERE doc_id = 'note-2'");
    await t.pool.query(
      `INSERT INTO documents (user_id, collection, doc_id, fields, field_hlcs, updated_seq, updated_at)
       VALUES ($1, 'tasks', 'stray', '{}', '{}', 1, now())`,
      [ada.userId],
    );
    await t.pool.query("UPDATE documents SET updated_seq = 1 WHERE doc_id = 'note-1'");
    const report = await verifier.verifyUser(ada.userId);
    expect(report.problems).toEqual(
      expect.arrayContaining([
        { kind: "missing_document", doc: "notes/note-2" },
        { kind: "unexpected_document", doc: "tasks/stray" },
        { kind: "updated_seq_mismatch", doc: "notes/note-1", expected: 5, actual: 1 },
      ]),
    );
    expect(report.problems).toHaveLength(3);
  });

  it("caps the problems it reports", async () => {
    await t.pool.query("DELETE FROM documents");
    const report = await new ConsistencyService({ pool: t.pool, maxProblems: 1 }).verifyUser(ada.userId);
    expect(report.problems).toHaveLength(1);
    expect(report.truncated).toBe(true);
  });
});

describe("StatsService", () => {
  it("counts the feed and the documents and tells how far each device lags", async () => {
    const phone = await addDevice(t, ada);
    await pull(t, phone, { after: 2 });
    const stats = await new StatsService({ pool: t.pool }).userStats(ada.userId);
    expect(stats.latestSeq).toBe(5);
    expect(stats.events).toBe(5);
    expect([...stats.documentsByCollection]).toEqual([["notes", 2]]);
    expect(stats.devices.map((d) => [d.name, d.behind])).toEqual([
      ["Ada's laptop", null],
      ["phone", 3],
    ]);
  });

  it("counts the events a device lags by, not the gap between sequence numbers", async () => {
    const grace = await createUser(t, "Grace");
    const now = t.clock.now();
    await push(t, grace, [mutation({ hlc: hlc(now - 5), fields: { title: "Grace's", body: "x", pinned: true } })]);
    await push(t, ada, [mutation({ hlc: hlc(now - 1), fields: { color: "red" } })]);
    await pull(t, ada, { after: 5 });
    const stats = await new StatsService({ pool: t.pool }).userStats(ada.userId);
    expect(stats.latestSeq).toBe(9);
    expect(stats.devices.map((d) => d.behind)).toEqual([1]);
  });
});
