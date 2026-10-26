import { access } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildTestApp, type TestApp } from "../helpers/app.js";
import {
  createTenant,
  expectStatus,
  markAvailable,
  storeFile,
  tenantUsage,
  type ErrorResponse,
  type FileBody,
  type TestTenant,
} from "../helpers/fixtures.js";

describe("downloads, signed links and deletion", () => {
  let t: TestApp;
  let tenant: TestTenant;

  beforeEach(async () => {
    t = await buildTestApp();
    tenant = await createTenant(t.pool, t.clock);
  });

  afterEach(async () => {
    await t.close();
  });

  async function availableFile(filePath: string, body: string, name?: string): Promise<FileBody> {
    const file = await storeFile(t.app, tenant, filePath, body);
    await markAvailable(t.pool, file.id);
    if (name !== undefined) {
      await t.pool.query("UPDATE files SET original_name = $2 WHERE id = $1", [file.id, name]);
    }
    return file;
  }

  it("refuses to serve a file that has not been scanned yet", async () => {
    const file = await storeFile(t.app, tenant, "notes/draft.txt", "not yet scanned");
    const response = await t.app.inject({ url: "/v1/files/notes/draft.txt", headers: tenant.headers });
    expectStatus(response, 409);
    expect(response.json<ErrorResponse>().error).toMatchObject({
      code: "file_not_available",
      details: { fileId: file.id, status: "pending_scan" },
    });
  });

  it("serves an available file by path and by id with safe headers", async () => {
    const file = await availableFile("notes/today.txt", "plain words", 'minutes "final".txt');
    for (const url of ["/v1/files/notes/today.txt", `/v1/files/by-id/${file.id}`]) {
      const response = await t.app.inject({ url, headers: tenant.headers });
      expectStatus(response, 200);
      expect(response.body).toBe("plain words");
      expect(response.headers).toMatchObject({
        "content-type": "text/plain; charset=utf-8",
        "content-length": "11",
        "content-disposition": 'attachment; filename="minutes _final_.txt"',
        "x-content-type-options": "nosniff",
        etag: `"${file.sha256}"`,
      });
    }
  });

  it("answers 304 to a matching If-None-Match", async () => {
    const file = await availableFile("a.txt", "cached");
    const response = await t.app.inject({
      url: "/v1/files/a.txt",
      headers: { ...tenant.headers, "if-none-match": `W/"other", "${file.sha256}"` },
    });
    expectStatus(response, 304);
    expect(response.body).toBe("");
  });

  it("serves metadata of any live file, scanned or not", async () => {
    const file = await storeFile(t.app, tenant, "a.txt", "meta");
    const response = await t.app.inject({ url: `/v1/files/by-id/${file.id}/meta`, headers: tenant.headers });
    expectStatus(response, 200);
    expect(response.json<FileBody>()).toEqual(file);
  });

  it("answers 502 without backend details when the object is gone from storage", async () => {
    const file = await availableFile("lost.txt", "lost");
    await t.storage.delete(`t/${tenant.tenantId}/${file.id}`);
    const response = await t.app.inject({ url: "/v1/files/lost.txt", headers: tenant.headers });
    expectStatus(response, 502);
    expect(response.json<ErrorResponse>().error).toEqual({
      code: "storage_error",
      message: "the storage backend failed",
      details: { storageCode: "NoSuchKey" },
    });
  });

  it("issues signed links that work without an API key until they expire", async () => {
    const file = await availableFile("share/report.txt", "shared");
    const signed = await t.app.inject({
      method: "POST",
      url: `/v1/files/by-id/${file.id}/signed-url`,
      headers: tenant.headers,
      payload: { expiresIn: 600 },
    });
    expectStatus(signed, 200);
    const { url, expiresAt } = signed.json<{ url: string; expiresAt: string }>();
    expect(expiresAt).toBe("2030-01-15T10:10:00.000Z");

    const download = await t.app.inject({ url });
    expectStatus(download, 200);
    expect(download.body).toBe("shared");

    t.clock.advanceSeconds(600);
    const expired = await t.app.inject({ url });
    expectStatus(expired, 403);
    expect(expired.json<ErrorResponse>().error.code).toBe("signed_url_expired");
  });

  it("refuses tampered links before looking at the expiry", async () => {
    const file = await availableFile("share/report.txt", "shared");
    const signed = await t.app.inject({
      method: "POST",
      url: `/v1/files/by-id/${file.id}/signed-url`,
      headers: tenant.headers,
      payload: { expiresIn: 60 },
    });
    const url = new URL(signed.json<{ url: string }>().url, "http://localhost");
    const exp = url.searchParams.get("exp") ?? "";
    const sig = url.searchParams.get("sig") ?? "";
    const variants = [
      `/v1/public/${file.id}?exp=${Number(exp) + 3600}&sig=${sig}`,
      `/v1/public/${file.id}?exp=${exp}&sig=${sig.toUpperCase()}`,
      `/v1/public/${file.id}?exp=0${exp}&sig=${sig}`,
      `/v1/public/${file.id}?exp=${exp}&sig=${sig.slice(0, 63)}`,
      `/v1/public/${crypto.randomUUID()}?exp=${exp}&sig=${sig}`,
    ];
    for (const variant of variants) {
      const response = await t.app.inject({ url: variant });
      expectStatus(response, 403);
      expect(response.json<ErrorResponse>().error.code).toBe("invalid_signature");
    }
  });

  it("refuses link lifetimes over the configured maximum", async () => {
    const file = await availableFile("a.txt", "x");
    const response = await t.app.inject({
      method: "POST",
      url: `/v1/files/by-id/${file.id}/signed-url`,
      headers: tenant.headers,
      payload: { expiresIn: t.config.signing.maxTtlSeconds + 1 },
    });
    expectStatus(response, 400);
  });

  it("stops serving a deleted file through its signed link", async () => {
    const file = await availableFile("a.txt", "x");
    const signed = await t.app.inject({
      method: "POST",
      url: `/v1/files/by-id/${file.id}/signed-url`,
      headers: tenant.headers,
      payload: { expiresIn: 60 },
    });
    expectStatus(await t.app.inject({ method: "DELETE", url: "/v1/files/a.txt", headers: tenant.headers }), 204);
    const response = await t.app.inject({ url: signed.json<{ url: string }>().url });
    expectStatus(response, 404);
  });

  it("deletes a file: 204, its bytes released and its object removed", async () => {
    const file = await storeFile(t.app, tenant, "old/archive.txt", "to be removed");
    expect(await tenantUsage(t.pool, tenant.tenantId)).toBe(13);
    const response = await t.app.inject({
      method: "DELETE",
      url: "/v1/files/old/archive.txt",
      headers: tenant.headers,
    });
    expectStatus(response, 204);
    expect(await tenantUsage(t.pool, tenant.tenantId)).toBe(0);
    const objectPath = path.join(t.storageRoot ?? "", "objects", "t", tenant.tenantId, file.id);
    await expect(access(objectPath)).rejects.toThrow();
    const row = await t.pool.query<{ status: string; object_deleted_at: Date | null }>(
      "SELECT status, object_deleted_at FROM files WHERE id = $1",
      [file.id],
    );
    expect(row.rows[0]?.status).toBe("deleted");
    expect(row.rows[0]?.object_deleted_at).not.toBeNull();

    expectStatus(await t.app.inject({ url: `/v1/files/by-id/${file.id}/meta`, headers: tenant.headers }), 404);
    expectStatus(
      await t.app.inject({ method: "DELETE", url: "/v1/files/old/archive.txt", headers: tenant.headers }),
      404,
    );
    // The path is free again.
    await storeFile(t.app, tenant, "old/archive.txt", "new");
  });
});
