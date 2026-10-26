import { HttpError, NetworkError, PULL_PATH, PUSH_PATH, ProtocolMismatchError } from "@sync/client";
import { ManualClock } from "@sync/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openClient, type TestClient } from "../helpers/clients.js";
import { startTestServer, type TestAccount, type TestServer } from "../helpers/testServer.js";

let server: TestServer;
let laptop: TestAccount;
const opened: TestClient[] = [];

function client(account: TestAccount = laptop, options: Parameters<typeof openClient>[2] = {}): TestClient {
  const c = openClient(server, account, options);
  opened.push(c);
  return c;
}

beforeEach(async () => {
  server = await startTestServer();
  laptop = await server.createUser("Ada");
});

afterEach(async () => {
  for (const c of opened.splice(0)) await c.client.close();
  await server.close();
});

describe("sync failures", () => {
  it("a push that never reached the server keeps the outbox and is retryable", async () => {
    const a = client();
    a.client.set("notes", "n1", { title: "x" });
    a.transport.failNext();
    const err = await a.client.sync().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NetworkError);
    expect(err).toMatchObject({ retryable: true });
    expect(a.client.pendingCount()).toBe(1);
    expect(a.client.syncState().lastError).toMatchObject({ code: "network_error", retryable: true });

    expect(await a.client.sync()).toMatchObject({ pushed: 1 });
    expect(await server.countEvents(laptop.userId)).toBe(1);
  });

  it("a push whose answer was lost is applied once when sent again", async () => {
    const a = client();
    a.client.set("notes", "n1", { title: "x", pinned: true });
    a.transport.dropNextResponse();
    await expect(a.client.sync()).rejects.toBeInstanceOf(NetworkError);
    expect(a.client.pendingCount()).toBe(1);
    expect(await server.countEvents(laptop.userId)).toBe(2);

    expect(await a.client.sync()).toEqual({ pushed: 1, pulled: 2, applied: 0 });
    expect(await server.countEvents(laptop.userId)).toBe(2);
    expect(a.client.pendingCount()).toBe(0);
  });

  it("a pull whose answer was lost is fetched again from the same cursor", async () => {
    const phone = await server.addDevice(laptop);
    const writer = client(phone);
    writer.client.set("tasks", "t1", { title: "remote" });
    await writer.client.sync();

    const a = client();
    a.transport.dropNextResponse();
    await expect(a.client.sync()).rejects.toBeInstanceOf(NetworkError);
    expect(a.client.pullCursor()).toBe(0);
    expect(await a.client.sync()).toEqual({ pushed: 0, pulled: 1, applied: 1 });
    expect(a.client.get("tasks", "t1")?.fields).toEqual({ title: "remote" });
  });

  it("a rejected token is a non-retryable HttpError", async () => {
    const stranger = client({ ...laptop, token: `sd_${laptop.deviceId}_${"A".repeat(43)}` });
    stranger.client.set("notes", "n1", { title: "x" });
    const err = await stranger.client.sync().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect(err).toMatchObject({ status: 401, retryable: false });
    expect(stranger.client.pendingCount()).toBe(1);
  });

  it("a server on another protocol version stops the sync", async () => {
    const a = client();
    a.transport.failNext(new ProtocolMismatchError("the server speaks protocol version 2", 2));
    await expect(a.client.sync()).rejects.toMatchObject({ code: "protocol_mismatch", retryable: false });
  });

  it("a write timestamped too far ahead is refused and stays queued", async () => {
    const a = client(laptop, { clock: new ManualClock(server.clock.now() + 3_600_000) });
    a.client.set("notes", "n1", { title: "from the future" });
    const err = await a.client.sync().catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 422, code: "clock_drift", retryable: false });
    expect(a.client.pendingCount()).toBe(1);
    expect(await server.countEvents(laptop.userId)).toBe(0);
  });

  it("a failed batch does not stop the batches before it from leaving the outbox", async () => {
    const a = client(laptop, { pushBatchSize: 2 });
    a.client.setMany(
      Array.from({ length: 5 }, (_, i) => ({ collection: "notes" as const, id: `n${i}`, fields: { title: `${i}` } })),
    );
    a.transport.holdNext().release();
    a.transport.failNext();
    await expect(a.client.sync()).rejects.toBeInstanceOf(NetworkError);
    expect(a.client.pendingCount()).toBe(3);
    expect(await a.client.sync()).toMatchObject({ pushed: 3 });
  });
});

describe("concurrent calls", () => {
  it("share one sync while it runs", async () => {
    const a = client();
    a.client.set("notes", "n1", { title: "x" });
    const gate = a.transport.holdNext();
    const first = a.client.sync();
    await gate.reached;
    const second = a.client.sync();
    expect(a.client.syncState().syncing).toBe(true);
    gate.release();
    const [r1, r2] = await Promise.all([first, second]);
    expect(r2).toBe(r1);
    expect(a.transport.count(PUSH_PATH)).toBe(1);
    expect(a.transport.count(PULL_PATH)).toBe(1);
  });

  it("a write made while a push runs goes out in the same sync, in a later batch", async () => {
    const a = client();
    a.client.set("notes", "n1", { title: "before" });
    const gate = a.transport.holdNext();
    const running = a.client.sync();
    await gate.reached;
    a.client.set("notes", "n2", { title: "during" });
    gate.release();
    expect(await running).toMatchObject({ pushed: 2 });
    expect(a.transport.count(PUSH_PATH)).toBe(2);
    expect(a.client.pendingCount()).toBe(0);
  });

  it("close waits for the running sync", async () => {
    const a = client();
    a.client.set("notes", "n1", { title: "x" });
    const gate = a.transport.holdNext();
    const running = a.client.sync();
    await gate.reached;
    const closing = a.client.close();
    await expect(a.client.sync()).rejects.toMatchObject({ code: "client_closed" });
    gate.release();
    await expect(running).resolves.toMatchObject({ pushed: 1 });
    await closing;
  });
});
