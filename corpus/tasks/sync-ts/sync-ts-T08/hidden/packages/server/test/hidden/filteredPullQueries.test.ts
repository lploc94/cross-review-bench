import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PullService } from "../../src/services/pullService.js";
import { buildTestApp, type TestApp } from "../helpers/app.js";
import { createUser, hlc, mutation, push, type TestDevice } from "../helpers/fixtures.js";

let t: TestApp;
let ada: TestDevice;

beforeEach(async () => {
  t = await buildTestApp();
  ada = await createUser(t);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await t.close();
});

describe("a pull filtered by collection", () => {
  it("issues as many queries for a user with 200 events of other collections first as for one without", async () => {
    const now = t.clock.now();
    // 40 tasks of 5 fields each: 200 events of another collection, then one note.
    const tasks = Array.from({ length: 40 }, (_, i) =>
      mutation({
        collection: "tasks",
        docId: `task-${i}`,
        hlc: hlc(now - 1_000 + i),
        fields: { title: `Task ${i}`, done: false, dueDate: null, priority: 1, notes: "n" },
      }),
    );
    expect((await push(t, ada, tasks)).statusCode).toBe(200);
    expect((await push(t, ada, [mutation({ docId: "note-1", hlc: hlc(now - 10), fields: { title: "Only note" } })])).statusCode).toBe(200);

    const grace = await createUser(t, "Grace");
    expect((await push(t, grace, [mutation({ docId: "note-1", hlc: hlc(now - 10), fields: { title: "Only note" } })])).statusCode).toBe(200);

    const service = new PullService({ pool: t.pool, clock: t.clock });
    const query = vi.spyOn(t.pool, "query");
    const eventQueries = async (device: TestDevice) => {
      query.mockClear();
      const page = await service.pull(device, 0, 10, ["notes"]);
      expect(page.events.map((e) => e.docId)).toEqual(["note-1"]);
      expect(page.hasMore).toBe(false);
      return query.mock.calls.filter(([text]) => typeof text === "string" && /\bFROM events\b/.test(text)).length;
    };
    // Grace has the note alone; Ada has 200 events of tasks before it.
    const alone = await eventQueries(grace);
    expect(alone).toBeGreaterThan(0);
    expect(await eventQueries(ada)).toBe(alone);
  });
});
