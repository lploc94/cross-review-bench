import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildTestApp, type TestApp } from "../helpers/app.js";
import { createUser, hlc, mutation, push, type TestDevice } from "../helpers/fixtures.js";

let t: TestApp;
let ada: TestDevice;

beforeEach(async () => {
  t = await buildTestApp();
  ada = await createUser(t);
});

afterEach(async () => {
  await t.close();
});

function getDocument(device: TestDevice, path: string) {
  return t.app.inject({ method: "GET", url: `/v1/documents/${path}`, headers: { authorization: `Bearer ${device.token}` } });
}

describe("GET /v1/documents/:collection/:id", () => {
  it("returns the materialised state with each field's timestamp", async () => {
    const now = t.clock.now();
    const first = mutation({ hlc: hlc(now - 20), fields: { title: "Draft", body: "text" } });
    const second = mutation({ hlc: hlc(now - 10), fields: { title: "Final" } });
    await push(t, ada, [first, second]);
    const res = await getDocument(ada, "notes/note-1");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      collection: "notes",
      id: "note-1",
      fields: { title: "Final", body: "text" },
      fieldHlcs: { title: second.hlc, body: first.hlc },
      updatedSeq: 3,
      updatedAt: new Date(now).toISOString(),
    });
  });

  it("answers 404 for a document that does not exist", async () => {
    const res = await getDocument(ada, "notes/missing");
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: { code: "not_found" } });
  });

  it("answers 404 for another user's document", async () => {
    const grace = await createUser(t, "Grace");
    await push(t, grace, [mutation({ hlc: hlc(t.clock.now()) })]);
    expect((await getDocument(ada, "notes/note-1")).statusCode).toBe(404);
    expect((await getDocument(grace, "notes/note-1")).statusCode).toBe(200);
  });

  it("answers 404 for an unknown collection and 400 for an invalid id", async () => {
    expect((await getDocument(ada, "contacts/c1")).statusCode).toBe(404);
    expect((await getDocument(ada, `notes/${"x".repeat(65)}`)).statusCode).toBe(400);
  });
});
