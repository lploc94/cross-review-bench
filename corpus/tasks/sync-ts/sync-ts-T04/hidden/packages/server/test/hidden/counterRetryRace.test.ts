import type { PushResponse } from "@sync/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConsistencyService } from "../../src/services/consistencyService.js";
import { buildTestApp, type TestApp } from "../helpers/app.js";
import { createUser, hlc, mutation, pull, push, type TestDevice } from "../helpers/fixtures.js";

let t: TestApp;
let ada: TestDevice;

beforeEach(async () => {
  t = await buildTestApp();
  ada = await createUser(t);
});

afterEach(async () => {
  await t.close();
});

/** Wait until `count` sessions of this database are blocked on a lock (bounded, never hangs). */
async function lockWaiters(count: number): Promise<void> {
  for (let i = 0; i < 1_000; i++) {
    const result = await t.pool.query<{ n: string }>(
      "SELECT count(*) AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'",
    );
    if (Number(result.rows[0]?.n ?? 0) >= count) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`fewer than ${count} sessions ever waited for a lock`);
}

async function timeSpent(): Promise<unknown> {
  const result = await t.pool.query<{ fields: Record<string, unknown> }>(
    "SELECT fields FROM documents WHERE user_id = $1 AND collection = 'tasks' AND doc_id = 'task-1'",
    [ada.userId],
  );
  return result.rows[0]?.fields.timeSpentSec;
}

describe("an increment whose push is sent again while the first one is still running", () => {
  it("is counted once", async () => {
    const now = t.clock.now();
    await push(t, ada, [
      mutation({ collection: "tasks", docId: "task-1", op: "increment", fields: { timeSpentSec: 300 }, hlc: hlc(now - 100) }),
    ]);
    const retried = mutation({
      collection: "tasks",
      docId: "task-1",
      op: "increment",
      fields: { timeSpentSec: 120 },
      hlc: hlc(now - 50),
    });

    // Another transaction holds the user's row, so both requests get as far as the user lock
    // before either of them commits: the first attempt and its retry after a lost answer.
    const holder = await t.pool.connect();
    let answers;
    try {
      await holder.query("BEGIN");
      await holder.query("SELECT 1 FROM users WHERE id = $1 FOR UPDATE", [ada.userId]);
      const first = push(t, ada, [retried]);
      const second = push(t, ada, [retried]);
      await lockWaiters(2);
      await holder.query("COMMIT");
      answers = await Promise.all([first, second]);
    } finally {
      holder.release();
    }

    expect(answers.map((res) => res.statusCode)).toEqual([200, 200]);
    for (const res of answers) expect(res.json<PushResponse>().acked).toEqual([retried.mutationId]);
    expect(await timeSpent()).toBe(420);

    const events = (await pull(t, ada)).json<{ events: { value: unknown }[] }>().events;
    expect(events.map((e) => e.value)).toEqual([300, 120]);
    const report = await new ConsistencyService({ pool: t.pool }).verifyUser(ada.userId);
    expect(report.problems).toEqual([]);
  });

  it("is counted once when three attempts race", async () => {
    const now = t.clock.now();
    const m = mutation({ collection: "tasks", docId: "task-1", op: "increment", fields: { timeSpentSec: 45 }, hlc: hlc(now - 10) });
    const holder = await t.pool.connect();
    try {
      await holder.query("BEGIN");
      await holder.query("SELECT 1 FROM users WHERE id = $1 FOR UPDATE", [ada.userId]);
      const pushes = [push(t, ada, [m]), push(t, ada, [m]), push(t, ada, [m])];
      await lockWaiters(3);
      await holder.query("COMMIT");
      expect((await Promise.all(pushes)).map((res) => res.statusCode)).toEqual([200, 200, 200]);
    } finally {
      holder.release();
    }
    expect(await timeSpent()).toBe(45);
  });
});
