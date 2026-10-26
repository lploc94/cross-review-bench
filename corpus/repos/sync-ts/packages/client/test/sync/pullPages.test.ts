import { InvalidResponseError, SyncClient, checkPage } from "@sync/client";
import { ManualClock, formatHlc, seededRandom, type PullResponse, type SyncEvent } from "@sync/shared";
import { describe, expect, it } from "vitest";
import { ScriptedTransport } from "../helpers/clients.js";

const clock = new ManualClock();
const DEVICE = "0b6f4a52-8d0e-4c43-9a51-6d2f0e7a9c11";

function event(seq: number, field: string, value: unknown, docId = "n1"): SyncEvent {
  return {
    seq,
    mutationId: `00000000-0000-4000-8000-${String(seq).padStart(12, "0")}`,
    deviceId: DEVICE,
    collection: "notes",
    docId,
    field,
    value: value as SyncEvent["value"],
    hlc: formatHlc({ wallMs: clock.now() - 1_000, counter: seq, node: "phone" }),
    serverReceivedAt: new Date(clock.now()).toISOString(),
  };
}

function page(events: SyncEvent[], nextAfter: number, hasMore = false): PullResponse {
  return { events, nextAfter, hasMore };
}

function open(transport: ScriptedTransport, pullLimit = 2): SyncClient {
  return SyncClient.open({ dbPath: ":memory:", transport, clock, random: seededRandom(7), pullLimit });
}

describe("checkPage", () => {
  it("accepts well-formed pages", () => {
    expect(() => checkPage(page([], 4), 4, 10)).not.toThrow();
    expect(() => checkPage(page([event(5, "title", "a"), event(9, "title", "b")], 9, true), 4, 2)).not.toThrow();
  });

  it.each([
    ["more events than the limit", page([event(5, "title", "a"), event(6, "title", "b")], 6), 4, 1],
    ["an event at or before the cursor", page([event(4, "title", "a")], 4), 4, 10],
    ["events out of order", page([event(7, "title", "a"), event(6, "title", "b")], 6), 4, 10],
    ["nextAfter that is not the last event", page([event(5, "title", "a")], 9), 4, 10],
    ["nextAfter moving without events", page([], 9), 4, 10],
    ["hasMore without events", page([], 4, true), 4, 10],
  ])("rejects %s", (_name, bad, after, limit) => {
    expect(() => checkPage(bad, after, limit)).toThrow(InvalidResponseError);
  });
});

describe("pulling pages", () => {
  it("follows pages until the server has no more", async () => {
    const transport = new ScriptedTransport()
      .answerPull(
        page([event(1, "title", "Plans"), event(2, "pinned", true)], 2, true),
        page([event(5, "color", "blue")], 5),
      );
    const client = open(transport);
    const result = await client.sync();
    expect(result).toEqual({ pushed: 0, pulled: 3, applied: 3 });
    expect(transport.pulls).toEqual([
      { after: 0, limit: 2 },
      { after: 2, limit: 2 },
    ]);
    expect(client.get("notes", "n1")?.fields).toEqual({ title: "Plans", pinned: true, color: "blue" });
    expect(client.pullCursor()).toBe(5);
    await client.close();
  });

  it("keeps the pages applied before a failure and resumes after them", async () => {
    const transport = new ScriptedTransport().answerPull(
      page([event(1, "title", "one")], 1, true),
      new Error("connection reset"),
    );
    const client = open(transport, 1);
    await expect(client.sync()).rejects.toThrow("connection reset");
    expect(client.pullCursor()).toBe(1);
    expect(client.get("notes", "n1")?.fields).toEqual({ title: "one" });

    transport.answerPull(page([event(2, "title", "two")], 2));
    await client.sync();
    expect(transport.pulls.at(-1)).toEqual({ after: 1, limit: 1 });
    expect(client.get("notes", "n1")?.fields).toEqual({ title: "two" });
    await client.close();
  });

  it("fails instead of looping on a page that announces more without progress", async () => {
    const transport = new ScriptedTransport().answerPull(page([], 0, true));
    const client = open(transport);
    await expect(client.sync()).rejects.toBeInstanceOf(InvalidResponseError);
    expect(transport.pulls).toHaveLength(1);
    expect(client.pullCursor()).toBe(0);
    await client.close();
  });

  it("applies nothing of a page with an event the client cannot hold", async () => {
    const transport = new ScriptedTransport().answerPull(
      page([event(1, "title", "fine"), event(2, "pinned", "not a boolean")], 2),
    );
    const client = open(transport);
    await expect(client.sync()).rejects.toMatchObject({ code: "invalid_response" });
    expect(client.get("notes", "n1")).toBeNull();
    expect(client.pullCursor()).toBe(0);
    await client.close();
  });

  it("keeps a newer local value over an older remote write", async () => {
    const transport = new ScriptedTransport().answerPush({ acked: [], serverHlc: formatHlc({ wallMs: clock.now(), counter: 0, node: "server" }) });
    const client = open(transport);
    client.set("notes", "n1", { title: "local" });
    transport.answerPull(page([event(1, "title", "older"), event(2, "color", "red")], 2));
    const result = await client.sync();
    expect(result.applied).toBe(1);
    expect(client.get("notes", "n1")?.fields).toEqual({ title: "local", color: "red" });
    await client.close();
  });

  it("records the sync state of each run", async () => {
    const transport = new ScriptedTransport().answerPull(new Error("offline"), page([], 0));
    const client = open(transport);
    const states: boolean[] = [];
    client.onSyncState((state) => states.push(state.syncing));
    await expect(client.sync()).rejects.toThrow("offline");
    expect(client.syncState()).toMatchObject({ syncing: false, lastSyncedAt: null, lastError: { code: "internal", retryable: false } });
    await client.sync();
    expect(client.syncState()).toEqual({ syncing: false, lastSyncedAt: clock.now(), lastError: null });
    expect(states).toEqual([true, false, true, false]);
    await client.close();
  });
});
