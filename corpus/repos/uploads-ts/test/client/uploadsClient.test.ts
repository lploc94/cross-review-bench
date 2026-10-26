import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApiError, encodeFilePath, UploadsClient } from "../../src/client/uploadsClient.js";
import { buildTestApp, type TestApp } from "../helpers/app.js";
import { createTenant, markAvailable, tenantUsage, type TestTenant } from "../helpers/fixtures.js";
import { chunkedStream, collect } from "../helpers/streams.js";

describe("UploadsClient against a listening server", () => {
  let t: TestApp;
  let tenant: TestTenant;
  let baseUrl: string;
  let client: UploadsClient;
  let workDir: string;

  beforeEach(async () => {
    t = await buildTestApp({ env: { MAX_UPLOAD_BYTES: "65536" } });
    tenant = await createTenant(t.pool, t.clock);
    await t.app.listen({ port: 0, host: "127.0.0.1" });
    baseUrl = `http://127.0.0.1:${(t.app.server.address() as AddressInfo).port}`;
    client = new UploadsClient({ baseUrl, token: tenant.token });
    workDir = await mkdtemp(path.join(os.tmpdir(), "uploads-client-test-"));
  });

  afterEach(async () => {
    await t.close();
    await rm(workDir, { recursive: true, force: true });
  });

  it("encodes each path segment", () => {
    expect(encodeFilePath("a b/c?d#e/f%g")).toBe("a%20b/c%3Fd%23e/f%25g");
  });

  it("puts, lists, downloads and deletes files", async () => {
    const stored = await client.putFile("team notes/week 1.txt", Buffer.from("agenda"), {
      contentType: "text/plain",
    });
    expect(stored.created).toBe(true);
    expect(stored.file.path).toBe("team notes/week 1.txt");

    const notYet = await client.getFile("team notes/week 1.txt").catch((err: unknown) => err);
    expect(notYet).toBeInstanceOf(ApiError);
    expect((notYet as ApiError).code).toBe("file_not_available");

    await markAvailable(t.pool, stored.file.id);
    const download = await client.getFile("team notes/week 1.txt");
    expect((await collect(download.body)).toString()).toBe("agenda");
    expect(download.size).toBe(6);

    const replaced = await client.putFile("team notes/week 1.txt", Buffer.from("agenda v2"), {
      overwrite: true,
    });
    expect(replaced.created).toBe(false);

    await client.putFile("b.txt", chunkedStream(["streamed ", "body"]), { size: 13 });
    const all: string[] = [];
    for await (const file of client.listAll(1)) all.push(file.path);
    expect(all).toEqual(["b.txt", "team notes/week 1.txt"]);

    await client.deleteFile("b.txt");
    const missing = await client.deleteFile("b.txt").catch((err: unknown) => err);
    expect((missing as ApiError).status).toBe(404);
    expect((await client.getTenant()).usedBytes).toBe(9);
  });

  it("downloads through a signed link without the API key", async () => {
    const stored = await client.putFile("share.txt", Buffer.from("public now"));
    await markAvailable(t.pool, stored.file.id);
    const signed = await client.createSignedUrl(stored.file.id, 300);
    const response = await fetch(new URL(signed.url, baseUrl));
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("public now");
  });

  it("delivers a 413 for an oversized body over a real connection", async () => {
    const error = await client.putFile("big.bin", Buffer.alloc(200_000)).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(413);
    expect(await tenantUsage(t.pool, tenant.tenantId)).toBe(0);
    // The connection is still usable afterwards.
    expect((await client.getTenant()).usedBytes).toBe(0);
  });

  it("delivers a 413 for an oversized multipart file over a real connection", async () => {
    const form = new FormData();
    form.append("path", "big.bin");
    form.append("file", new Blob([new Uint8Array(200_000)]), "big.bin");
    const response = await fetch(`${baseUrl}/v1/files`, {
      method: "POST",
      headers: { authorization: `Bearer ${tenant.token}` },
      body: form,
    });
    expect(response.status).toBe(413);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe("payload_too_large");
    expect((await client.getTenant()).usedBytes).toBe(0);
  });

  it("refuses a dot-segment path sent unnormalized", async () => {
    const response = await new Promise<number>((resolve, reject) => {
      // fetch normalizes URLs, so write the request line by hand.
      import("node:http").then(({ request }) => {
        const req = request(
          `${baseUrl}/v1/files/a/../b.txt`,
          { method: "PUT", headers: { authorization: `Bearer ${tenant.token}`, "content-length": "1" } },
          (res) => {
            res.resume();
            resolve(res.statusCode ?? 0);
          },
        );
        req.on("error", reject);
        req.path = "/v1/files/a/../b.txt";
        req.end("x");
      }, reject);
    });
    expect(response).toBe(400);
  });

  it("uploads a file in resumable chunks", async () => {
    const content = randomBytes(10_000);
    const local = path.join(workDir, "payload.bin");
    await writeFile(local, content);
    const progress: number[] = [];
    const stored = await client.uploadFileResumable(local, "backups/payload.bin", {
      chunkSize: 4096,
      onProgress: (uploaded) => progress.push(uploaded),
    });
    expect(stored.created).toBe(true);
    expect(stored.file.size).toBe(10_000);
    expect(progress).toEqual([4096, 8192, 10_000]);
    await markAvailable(t.pool, stored.file.id);
    expect(await collect((await client.getFileById(stored.file.id)).body)).toEqual(content);
  });

  it("resumes a session from the server's offset", async () => {
    const content = randomBytes(5000);
    const local = path.join(workDir, "resume.bin");
    await writeFile(local, content);
    const session = await client.createUpload({ path: "resume.bin", size: 5000 });
    expect(await client.uploadChunk(session.id, 0, content.subarray(0, 3000))).toBe(3000);

    // A chunk whose answer was lost: the server reports where it really is.
    const mismatch = await client.uploadChunk(session.id, 0, content.subarray(0, 1000)).catch((err: unknown) => err);
    expect((mismatch as ApiError).uploadOffset).toBe(3000);

    const stored = await client.uploadFileResumable(local, "resume.bin", { sessionId: session.id, chunkSize: 1024 });
    expect(stored.file.size).toBe(5000);
    await markAvailable(t.pool, stored.file.id);
    expect(await collect((await client.getFileById(stored.file.id)).body)).toEqual(content);
  });

  it("aborts an upload", async () => {
    const session = await client.createUpload({ path: "dropped.bin", size: 100 });
    expect((await client.getTenant()).usedBytes).toBe(100);
    await client.abortUpload(session.id);
    expect((await client.getTenant()).usedBytes).toBe(0);
    const error = await client.getUploadOffset(session.id).catch((err: unknown) => err);
    expect((error as ApiError).status).toBe(409);
  });
});
