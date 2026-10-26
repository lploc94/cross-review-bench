import { NetworkError, openDatabase } from "@sync/client";
import { PROTOCOL_HEADER, PROTOCOL_VERSION, formatHlc, type MutationPayload, type PushResponse } from "@sync/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openClient, type TestClient } from "../helpers/clients.js";
import { tempDbPath } from "../helpers/tempFiles.js";
import { startTestServer, type TestAccount, type TestServer } from "../helpers/testServer.js";

let server: TestServer;
let laptop: TestAccount;
const opened: TestClient[] = [];
let ids = 0;

beforeEach(async () => {
  server = await startTestServer();
  laptop = await server.createUser("Ada");
});

afterEach(async () => {
  for (const c of opened.splice(0)) await c.client.close();
  await server.close();
});

function m(docId: string, fields: Record<string, unknown>): MutationPayload {
  ids += 1;
  return {
    mutationId: `00000000-0000-4000-8000-${ids.toString(16).padStart(12, "0")}`,
    collection: "notes",
    docId,
    op: "set",
    fields: fields as MutationPayload["fields"],
    hlc: formatHlc({ wallMs: server.clock.now() - 1_000, counter: ids, node: "laptop" }),
  };
}

async function push(mutations: MutationPayload[]): Promise<PushResponse> {
  const res = await server.app.inject({
    method: "POST",
    url: "/v1/sync/push",
    headers: { authorization: `Bearer ${laptop.token}`, [PROTOCOL_HEADER]: String(PROTOCOL_VERSION) },
    payload: { mutations },
  });
  expect(res.statusCode).toBe(200);
  return res.json<PushResponse>();
}

describe("rejections in a push that repeats recorded mutations", () => {
  it("give the index in the request after one recorded mutation", async () => {
    const seen = m("n1", { title: "seen" });
    await push([seen]);
    const valid = m("n2", { title: "valid" });
    const invalid = m("n3", { title: "x", archived: true });
    const answer = await push([seen, valid, invalid]);
    expect(answer.acked).toEqual([seen.mutationId, valid.mutationId]);
    expect(answer.rejected).toHaveLength(1);
    expect(answer.rejected[0]?.index).toBe(2);
  });

  it("give the index in the request with recorded mutations on both sides", async () => {
    const before = m("a", { title: "a" });
    const after = m("c", { title: "c" });
    await push([before, after]);
    const invalid = m("b", { pinned: "yes" });
    const fresh = m("d", { title: "d" });
    const answer = await push([before, invalid, after, fresh]);
    expect(answer.acked).toEqual([before.mutationId, after.mutationId, fresh.mutationId]);
    expect(answer.rejected.map((r) => r.index)).toEqual([1]);
  });

  it("let a client whose answer was lost mark the right mutation and sync the rest", async () => {
    const dbPath = tempDbPath();
    const writer = openClient(server, laptop, { dbPath });
    writer.client.setMany(["n1", "n2", "n3", "n4"].map((id) => ({ collection: "notes" as const, id, fields: { title: id } })));
    await writer.client.close();
    const db = openDatabase(dbPath);
    db.prepare("UPDATE outbox SET fields = ? WHERE doc_id = 'n2'").run(JSON.stringify({ title: "n2", archived: true }));
    db.close();

    const a = openClient(server, laptop, { dbPath, pushBatchSize: 3 });
    opened.push(a);
    a.transport.dropNextResponse();
    await expect(a.client.sync()).rejects.toBeInstanceOf(NetworkError);

    await expect(a.client.sync()).resolves.toMatchObject({ pushed: 3 });
    expect(a.client.rejectedMutations().map((r) => r.mutation.docId)).toEqual(["n2"]);
    expect(a.client.pendingCount()).toBe(0);
    const docs = await server.pool.query<{ doc_id: string }>(
      "SELECT doc_id FROM documents WHERE user_id = $1 ORDER BY doc_id",
      [laptop.userId],
    );
    expect(docs.rows.map((r) => r.doc_id)).toEqual(["n1", "n3", "n4"]);
  });
});
