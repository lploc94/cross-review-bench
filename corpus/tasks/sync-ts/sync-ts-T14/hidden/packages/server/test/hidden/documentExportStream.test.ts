import http from "node:http";
import type { AddressInfo } from "node:net";
import type { Readable } from "node:stream";
import { exportLineSchema } from "@sync/shared";
import { afterEach, describe, expect, it } from "vitest";
import { ExportService } from "../../src/services/exportService.js";
import { buildTestApp, type TestApp } from "../helpers/app.js";
import { createUser, hlc, mutation, push, type TestDevice } from "../helpers/fixtures.js";

let t: TestApp | null = null;

afterEach(async () => {
  await t?.close();
  t = null;
});

async function start(env: Record<string, string> = {}): Promise<{ app: TestApp; ada: TestDevice }> {
  t = await buildTestApp({ env });
  return { app: t, ada: await createUser(t) };
}

async function seed(app: TestApp, user: TestDevice, collection: string, count: number, bodyLength = 10): Promise<void> {
  await app.pool.query(
    `INSERT INTO documents (user_id, collection, doc_id, fields, field_hlcs, updated_seq, updated_at)
     SELECT $1, $2, 'doc-' || lpad(i::text, 5, '0'),
            jsonb_build_object('title', 'Title ' || i, 'body', repeat('y', $4::int)),
            jsonb_build_object('title', $5::text, 'body', $5::text), i, now()
       FROM generate_series(1, $3::int) AS i`,
    [user.userId, collection, count, bodyLength, hlc(app.clock.now() - 5_000)],
  );
}

async function readAll(stream: Readable): Promise<string> {
  stream.setEncoding("utf8");
  let text = "";
  for await (const chunk of stream) text += chunk as string;
  return text;
}

async function settled(app: TestApp, service?: ExportService): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (app.pool.totalCount === app.pool.idleCount && (service?.running ?? 0) === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`connections still checked out: ${app.pool.totalCount - app.pool.idleCount}`);
}

const toLine = (doc: { collection: string; docId: string }) => ({ ref: `${doc.collection}/${doc.docId}` });

describe("export paging", () => {
  it.each([0, 1, 2, 3, 4, 6, 7])("lists %i documents once each, in table order, with the count", async (count) => {
    const { app, ada } = await start();
    await seed(app, ada, "tasks", count);
    await seed(app, ada, "notes", Math.max(0, count - 2));
    const expected = await app.pool.query<{ ref: string }>(
      "SELECT collection || '/' || doc_id AS ref FROM documents WHERE user_id = $1 ORDER BY collection, doc_id",
      [ada.userId],
    );
    const service = new ExportService({ pool: app.pool, maxConcurrent: 1, idleTimeoutMs: 10_000, pageSize: 3 });
    const lines = (await readAll(await service.open(ada, toLine))).trimEnd().split("\n").map((l) => JSON.parse(l) as unknown);
    expect(lines.slice(0, -1)).toEqual(expected.rows);
    expect(lines.at(-1)).toEqual({ type: "end", documents: expected.rows.length });
    await settled(app, service);
  });

  it("answers each document as GET /v1/documents shows it, and only the caller's", async () => {
    const { app, ada } = await start();
    const bob = await createUser(app, "Bob");
    const now = app.clock.now();
    await push(app, ada, [
      mutation({ docId: "trip", fields: { title: "Trip", tags: ["travel", "summer"], pinned: true }, hlc: hlc(now - 2) }),
      mutation({ collection: "tasks", docId: "pack", fields: { title: "Pack", dueDate: null, priority: 3 }, hlc: hlc(now - 1) }),
      mutation({ docId: "trip", fields: { body: "Ünïcode ✓ text" }, hlc: hlc(now) }),
    ]);
    await push(app, bob, [mutation({ docId: "secret", fields: { title: "Bob only" }, hlc: hlc(now) })]);
    const auth = { authorization: `Bearer ${ada.token}` };
    const res = await app.app.inject({ method: "GET", url: "/v1/export", headers: auth });
    expect(res.statusCode).toBe(200);
    const lines = res.body.trimEnd().split("\n").map((l) => exportLineSchema.parse(JSON.parse(l)));
    expect(lines).toHaveLength(3);
    for (const line of lines.slice(0, 2)) {
      if (line.type !== "document") throw new Error("expected a document line");
      const one = await app.app.inject({ method: "GET", url: `/v1/documents/${line.collection}/${line.id}`, headers: auth });
      expect({ ...line }).toEqual({ type: "document", ...one.json<object>() });
    }
    expect(lines[2]).toEqual({ type: "end", documents: 2 });
    expect((await app.app.inject({ method: "HEAD", url: "/v1/export", headers: auth })).statusCode).toBe(404);
  });
});

describe("export resources", () => {
  it("answers 503 beyond EXPORT_MAX_CONCURRENT and serves again once the running export is gone", async () => {
    const { app, ada } = await start({ EXPORT_MAX_CONCURRENT: "1" });
    await seed(app, ada, "notes", 4_000, 8_000);
    await app.app.listen({ port: 0, host: "127.0.0.1" });
    const { port } = app.app.server.address() as AddressInfo;
    const req = http.get({ port, path: "/v1/export", headers: { authorization: `Bearer ${ada.token}` } });
    await new Promise<void>((resolve, reject) => {
      req.once("response", (res) => {
        res.once("data", () => {
          res.pause();
          resolve();
        });
      });
      req.once("error", reject);
      req.setTimeout(5_000, () => reject(new Error("no answer from the first export")));
    });

    const busy = await app.app.inject({ method: "GET", url: "/v1/export", headers: { authorization: `Bearer ${ada.token}` } });
    expect(busy.statusCode).toBe(503);
    expect(busy.json()).toMatchObject({ error: { code: "unavailable" } });

    req.destroy();
    await settled(app);
    const again = await app.app.inject({ method: "GET", url: "/v1/export", headers: { authorization: `Bearer ${ada.token}` } });
    expect(again.statusCode).toBe(200);
    expect(again.body.trimEnd().split("\n").at(-1)).toBe('{"type":"end","documents":4000}');
  });

  it("cuts off a consumer that stops reading and releases its connection", async () => {
    const { app, ada } = await start();
    await seed(app, ada, "notes", 400, 1_000);
    const service = new ExportService({ pool: app.pool, maxConcurrent: 1, idleTimeoutMs: 150, pageSize: 20 });
    const stream = await service.open(ada, toLine);
    const failed = new Promise<unknown>((resolve) => stream.once("error", resolve));
    stream.read(1);
    expect(await failed).toMatchObject({ message: expect.stringMatching(/stalled/) as unknown });
    await settled(app, service);
  });

  it("survives the database ending the session between pages", async () => {
    const { app, ada } = await start();
    await seed(app, ada, "notes", 50);
    const service = new ExportService({ pool: app.pool, maxConcurrent: 1, idleTimeoutMs: 10_000, pageSize: 10 });
    const stream = await service.open(ada, toLine);
    const failed = new Promise<unknown>((resolve) => stream.once("error", resolve));
    const killed = await app.pool.query<{ ok: boolean }>(
      `SELECT pg_terminate_backend(pid) AS ok FROM pg_stat_activity
        WHERE datname = current_database() AND state = 'idle in transaction' AND pid <> pg_backend_pid()`,
    );
    expect(killed.rows).toEqual([{ ok: true }]);
    expect(await failed).toBeInstanceOf(Error);
    await settled(app, service);

    const next = await readAll(await service.open(ada, toLine));
    expect(next.trimEnd().split("\n").at(-1)).toBe('{"type":"end","documents":50}');
    await settled(app, service);
  });
});
