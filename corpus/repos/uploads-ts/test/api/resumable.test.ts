import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { LightMyRequestResponse } from "fastify";
import { buildTestApp, type TestApp } from "../helpers/app.js";
import {
  createTenant,
  expectStatus,
  storeFile,
  tenantUsage,
  type ErrorResponse,
  type FileBody,
  type SessionBody,
  type TestTenant,
} from "../helpers/fixtures.js";
import { png } from "../helpers/images.js";

describe("resumable uploads", () => {
  let t: TestApp;
  let tenant: TestTenant;

  beforeEach(async () => {
    t = await buildTestApp({ env: { MAX_UPLOAD_BYTES: "100000", UPLOAD_SESSION_TTL_S: "3600" } });
    tenant = await createTenant(t.pool, t.clock, { quotaBytes: 200_000 });
  });

  afterEach(async () => {
    await t.close();
  });

  async function createSession(body: object, query = ""): Promise<LightMyRequestResponse> {
    return t.app.inject({ method: "POST", url: `/v1/uploads${query}`, headers: tenant.headers, payload: body });
  }

  async function openSession(filePath: string, size: number): Promise<SessionBody> {
    const response = await createSession({ path: filePath, size });
    expectStatus(response, 201);
    return response.json<SessionBody>();
  }

  function sendChunk(id: string, offset: number, chunk: Buffer, contentType = "application/offset+octet-stream") {
    return t.app.inject({
      method: "PATCH",
      url: `/v1/uploads/${id}`,
      headers: { ...tenant.headers, "upload-offset": String(offset), "content-type": contentType },
      payload: chunk,
    });
  }

  it("uploads a file in chunks and completes it", async () => {
    const image = png(30, 20);
    const created = await createSession({ path: "albums/sea.png", size: image.length, contentType: "image/png" });
    expectStatus(created, 201);
    const session = created.json<SessionBody>();
    expect(created.headers.location).toBe(`/v1/uploads/${session.id}`);
    expect(created.headers["upload-offset"]).toBe("0");
    expect(session).toMatchObject({ state: "open", size: image.length, offset: 0, declaredType: "image/png" });
    expect(await tenantUsage(t.pool, tenant.tenantId)).toBe(image.length);

    const first = await sendChunk(session.id, 0, image.subarray(0, 20));
    expectStatus(first, 204);
    expect(first.headers["upload-offset"]).toBe("20");
    const second = await sendChunk(session.id, 20, image.subarray(20), "text/plain");
    expectStatus(second, 204);
    expect(second.headers["upload-offset"]).toBe(String(image.length));

    const head = await t.app.inject({ method: "HEAD", url: `/v1/uploads/${session.id}`, headers: tenant.headers });
    expectStatus(head, 200);
    expect(head.headers["upload-length"]).toBe(String(image.length));

    const completed = await t.app.inject({
      method: "POST",
      url: `/v1/uploads/${session.id}/complete`,
      headers: tenant.headers,
    });
    expectStatus(completed, 201);
    expect(completed.json<FileBody>()).toMatchObject({
      path: "albums/sea.png",
      size: image.length,
      contentType: "image/png",
      declaredType: "image/png",
      image: { width: 30, height: 20 },
      status: "pending_scan",
    });
    expect(await tenantUsage(t.pool, tenant.tenantId)).toBe(image.length);
    expect(await t.storage.listStaging()).toEqual([]);

    const again = await sendChunk(session.id, image.length, Buffer.from("x"));
    expectStatus(again, 409);
    expect(again.json<ErrorResponse>().error).toMatchObject({
      code: "upload_session_state",
      details: { state: "completed" },
    });
  });

  it("answers an offset mismatch with the session's offset", async () => {
    const session = await openSession("a.bin", 10);
    expectStatus(await sendChunk(session.id, 0, Buffer.from("abcd")), 204);
    const repeated = await sendChunk(session.id, 0, Buffer.from("abcd"));
    expectStatus(repeated, 409);
    expect(repeated.headers["upload-offset"]).toBe("4");
    expect(repeated.json<ErrorResponse>().error.code).toBe("offset_mismatch");
  });

  it("refuses a chunk that runs past the declared size and keeps the offset", async () => {
    const session = await openSession("a.bin", 10);
    expectStatus(await sendChunk(session.id, 0, Buffer.from("abcdefgh")), 204);
    const tooLong = await sendChunk(session.id, 8, Buffer.from("xyz"));
    expectStatus(tooLong, 413);
    const head = await t.app.inject({ method: "HEAD", url: `/v1/uploads/${session.id}`, headers: tenant.headers });
    expect(head.headers["upload-offset"]).toBe("8");
    expectStatus(await sendChunk(session.id, 8, Buffer.from("xy")), 204);
  });

  it("refuses an empty chunk and a missing Upload-Offset", async () => {
    const session = await openSession("a.bin", 10);
    expectStatus(await sendChunk(session.id, 0, Buffer.alloc(0)), 400);
    const missing = await t.app.inject({
      method: "PATCH",
      url: `/v1/uploads/${session.id}`,
      headers: { ...tenant.headers, "content-type": "application/octet-stream" },
      payload: "abc",
    });
    expectStatus(missing, 400);
  });

  it("answers 409 to a chunk while another one is being written", async () => {
    const session = await openSession("a.bin", 10);
    await t.pool.query(
      "UPDATE upload_sessions SET chunk_token = gen_random_uuid(), chunk_lease_expires_at = $2 WHERE id = $1",
      [session.id, new Date(t.clock.now().getTime() + 60_000)],
    );
    const blocked = await sendChunk(session.id, 0, Buffer.from("abc"));
    expectStatus(blocked, 409);
    expect(blocked.json<ErrorResponse>().error.code).toBe("chunk_in_progress");
    const completing = await t.app.inject({
      method: "POST",
      url: `/v1/uploads/${session.id}/complete`,
      headers: tenant.headers,
    });
    expect(completing.json<ErrorResponse>().error.code).toBe("chunk_in_progress");

    // A writer that vanished loses its claim when the lease lapses.
    t.clock.advanceSeconds(61);
    expectStatus(await sendChunk(session.id, 0, Buffer.from("abc")), 204);
  });

  it("refuses to complete an incomplete upload", async () => {
    const session = await openSession("a.bin", 10);
    expectStatus(await sendChunk(session.id, 0, Buffer.from("abc")), 204);
    const response = await t.app.inject({
      method: "POST",
      url: `/v1/uploads/${session.id}/complete`,
      headers: tenant.headers,
    });
    expectStatus(response, 409);
    expect(response.json<ErrorResponse>().error).toMatchObject({
      code: "upload_incomplete",
      details: { offset: 3, size: 10 },
    });
  });

  it("checks size, path and quota when the session is created", async () => {
    await storeFile(t.app, tenant, "taken.txt", "x");
    expectStatus(await createSession({ path: "taken.txt", size: 5 }), 409);
    expectStatus(await createSession({ path: "taken.txt", size: 5 }, "?overwrite=true"), 201);
    expectStatus(await createSession({ path: "big.bin", size: 100_001 }), 413);
    expectStatus(await createSession({ path: "a.bin", size: 0 }), 400);
    expectStatus(await createSession({ path: "a.bin", size: 5, contentType: "not a type" }), 400);
    // 6 bytes are in use so far; sessions reserve their whole size up front.
    expectStatus(await createSession({ path: "huge.bin", size: 99_000 }), 201);
    expectStatus(await createSession({ path: "huge2.bin", size: 99_000 }), 201);
    expectStatus(await createSession({ path: "huge3.bin", size: 1_995 }), 422);
    expectStatus(await createSession({ path: "huge3.bin", size: 1_994 }), 201);
  });

  it("replaces an existing file on completion when created with overwrite", async () => {
    await storeFile(t.app, tenant, "notes.txt", "old contents");
    const created = await createSession({ path: "notes.txt", size: 3 }, "?overwrite=true");
    const session = created.json<SessionBody>();
    expect(await tenantUsage(t.pool, tenant.tenantId)).toBe(15);
    expectStatus(await sendChunk(session.id, 0, Buffer.from("new")), 204);
    const completed = await t.app.inject({
      method: "POST",
      url: `/v1/uploads/${session.id}/complete`,
      headers: tenant.headers,
    });
    expectStatus(completed, 200);
    expect(await tenantUsage(t.pool, tenant.tenantId)).toBe(3);
  });

  it("aborts a session, releasing its bytes and staged chunks", async () => {
    const session = await openSession("a.bin", 10);
    expectStatus(await sendChunk(session.id, 0, Buffer.from("abc")), 204);
    expect(await t.storage.listStaging()).toEqual([session.id]);
    const aborted = await t.app.inject({ method: "DELETE", url: `/v1/uploads/${session.id}`, headers: tenant.headers });
    expectStatus(aborted, 204);
    expect(await tenantUsage(t.pool, tenant.tenantId)).toBe(0);
    expect(await t.storage.listStaging()).toEqual([]);
    expectStatus(await t.app.inject({ method: "DELETE", url: `/v1/uploads/${session.id}`, headers: tenant.headers }), 409);
    expectStatus(await t.app.inject({ method: "HEAD", url: `/v1/uploads/${session.id}`, headers: tenant.headers }), 409);
  });

  it("treats a session past its expiry as expired before cleanup closes it", async () => {
    const session = await openSession("a.bin", 10);
    t.clock.advanceSeconds(3600);
    const late = await sendChunk(session.id, 0, Buffer.from("abc"));
    expectStatus(late, 409);
    expect(late.json<ErrorResponse>().error.details).toMatchObject({ state: "expired" });
  });

  it("hides other tenants' sessions", async () => {
    const session = await openSession("a.bin", 10);
    const other = await createTenant(t.pool, t.clock, { name: "Harbor Logistics" });
    const response = await t.app.inject({
      method: "PATCH",
      url: `/v1/uploads/${session.id}`,
      headers: { ...other.headers, "upload-offset": "0", "content-type": "application/octet-stream" },
      payload: "abc",
    });
    expectStatus(response, 404);
  });
});
