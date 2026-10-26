import type { PullResponse, SyncStatusResponse } from "@sync/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildTestApp, type TestApp } from "../helpers/app.js";
import { addDevice, createUser, hlc, mutation, pull, push, syncHeaders, type TestDevice } from "../helpers/fixtures.js";

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

/** Push `count` single-field notes; event seqs are 1..count. */
async function pushNotes(device: TestDevice, count: number, from = 0) {
  const mutations = Array.from({ length: count }, (_, i) =>
    mutation({ docId: `note-${from + i}`, hlc: hlc(now - 10_000 + from + i), fields: { title: `Note ${from + i}` } }),
  );
  expect((await push(t, device, mutations)).statusCode).toBe(200);
  return mutations;
}

async function cursorOf(device: TestDevice) {
  const result = await t.pool.query<{ last_pulled_seq: string }>(
    "SELECT last_pulled_seq FROM device_cursors WHERE device_id = $1",
    [device.deviceId],
  );
  return result.rows[0]?.last_pulled_seq;
}

describe("GET /v1/sync/pull", () => {
  it("answers an empty feed", async () => {
    const res = await pull(t, ada);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ events: [], nextAfter: 0, hasMore: false });
  });

  it("returns the events after the cursor, in seq order, with what the device needs", async () => {
    const [m] = await pushNotes(ada, 1);
    const res = await pull(t, ada, { after: 0 });
    const body = res.json<PullResponse>();
    expect(body.events).toEqual([
      {
        seq: 1,
        mutationId: m?.mutationId,
        deviceId: ada.deviceId,
        collection: "notes",
        docId: "note-0",
        field: "title",
        value: "Note 0",
        hlc: m?.hlc,
        serverReceivedAt: new Date(now).toISOString(),
      },
    ]);
    expect(body.nextAfter).toBe(1);
    expect(body.hasMore).toBe(false);
  });

  it("pages with limit, hasMore and nextAfter", async () => {
    await pushNotes(ada, 5);
    const first = (await pull(t, ada, { after: 0, limit: 2 })).json<PullResponse>();
    expect(first.events.map((e) => e.seq)).toEqual([1, 2]);
    expect(first).toMatchObject({ nextAfter: 2, hasMore: true });
    const second = (await pull(t, ada, { after: 2, limit: 2 })).json<PullResponse>();
    expect(second.events.map((e) => e.seq)).toEqual([3, 4]);
    expect(second.hasMore).toBe(true);
    const last = (await pull(t, ada, { after: 4, limit: 2 })).json<PullResponse>();
    expect(last.events.map((e) => e.seq)).toEqual([5]);
    expect(last).toMatchObject({ nextAfter: 5, hasMore: false });
  });

  it("says there is no more when the page is exactly full", async () => {
    await pushNotes(ada, 2);
    const page = (await pull(t, ada, { after: 0, limit: 2 })).json<PullResponse>();
    expect(page.events).toHaveLength(2);
    expect(page.hasMore).toBe(false);
  });

  it("keeps nextAfter at the cursor when nothing is new", async () => {
    await pushNotes(ada, 2);
    expect((await pull(t, ada, { after: 2 })).json()).toEqual({ events: [], nextAfter: 2, hasMore: false });
  });

  it("only shows the caller's user's events", async () => {
    const grace = await createUser(t, "Grace");
    await pushNotes(grace, 3);
    await pushNotes(ada, 1, 10);
    const page = (await pull(t, ada)).json<PullResponse>();
    expect(page.events.map((e) => e.docId)).toEqual(["note-10"]);
    expect(page.events[0]?.seq).toBe(4);
  });

  it("includes the events of every device of the user", async () => {
    const phone = await addDevice(t, ada);
    await pushNotes(ada, 1);
    await pushNotes(phone, 1, 1);
    const page = (await pull(t, phone)).json<PullResponse>();
    expect(page.events.map((e) => e.deviceId)).toEqual([ada.deviceId, phone.deviceId]);
  });

  it("records the cursor the device confirmed", async () => {
    await pushNotes(ada, 3);
    expect(await cursorOf(ada)).toBeUndefined();
    await pull(t, ada, { after: 0, limit: 2 });
    expect(await cursorOf(ada)).toBe("0");
    await pull(t, ada, { after: 2 });
    expect(await cursorOf(ada)).toBe("2");
  });

  it("uses the configured default limit", async () => {
    const small = await buildTestApp({ env: { PULL_DEFAULT_LIMIT: "2" } });
    try {
      await pushNotes(ada, 3);
      const page = (await pull(small, ada)).json<PullResponse>();
      expect(page.events).toHaveLength(2);
      expect(page.hasMore).toBe(true);
    } finally {
      await small.close();
    }
  });

  it("rejects invalid cursors and limits", async () => {
    const cases = [
      { after: -1 },
      { after: "abc" },
      { after: "1.5" },
      { after: "" },
      { after: "99999999999999999" },
      { limit: 0 },
      { limit: 1001 },
      { limit: "ten" },
    ];
    for (const query of cases) {
      const res = await pull(t, ada, query);
      expect(res.statusCode, JSON.stringify(query)).toBe(400);
      expect(res.json()).toMatchObject({ error: { code: "validation_error" } });
    }
  });

  it("keeps JSON values as they were written", async () => {
    await push(t, ada, [
      mutation({
        collection: "tasks",
        docId: "task-1",
        hlc: hlc(now - 5),
        fields: { title: "Call the plumber", dueDate: null, priority: 2, done: false },
      }),
    ]);
    const page = (await pull(t, ada)).json<PullResponse>();
    expect(Object.fromEntries(page.events.map((e) => [e.field, e.value]))).toEqual({
      title: "Call the plumber",
      dueDate: null,
      priority: 2,
      done: false,
    });
  });
});

describe("GET /v1/sync/status", () => {
  it("tells how far behind the device is", async () => {
    const status = async () =>
      (await t.app.inject({ method: "GET", url: "/v1/sync/status", headers: syncHeaders(ada) })).json<SyncStatusResponse>();
    expect(await status()).toEqual({ latestSeq: 0, cursor: null });
    await pushNotes(ada, 3);
    await pull(t, ada, { after: 1 });
    expect(await status()).toEqual({ latestSeq: 3, cursor: 1 });
  });
});
