import { createHash } from "node:crypto";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildTestApp, type TestApp } from "../helpers/app.js";
import {
  createTenant,
  expectStatus,
  multipartBody,
  putFile,
  storeFile,
  tenantUsage,
  type ErrorResponse,
  type FileBody,
  type TestTenant,
} from "../helpers/fixtures.js";
import { jpeg, pdf, png } from "../helpers/images.js";

describe("direct uploads", () => {
  let t: TestApp;
  let tenant: TestTenant;

  beforeEach(async () => {
    t = await buildTestApp({ env: { MAX_UPLOAD_BYTES: "8192" } });
    tenant = await createTenant(t.pool, t.clock, { quotaBytes: 20_000 });
  });

  afterEach(async () => {
    await t.close();
  });

  async function storedObjects(): Promise<string[]> {
    const root = path.join(t.storageRoot ?? "", "objects", "t", tenant.tenantId);
    return readdir(root).catch(() => []);
  }

  it("stores a raw body, sniffs its type and counts it against the quota", async () => {
    const body = png(64, 48);
    const response = await putFile(t.app, tenant, "photos/2030/cover.png", body, {
      contentType: "text/plain",
    });
    expectStatus(response, 201);
    const file = response.json<FileBody>();
    expect(file).toMatchObject({
      path: "photos/2030/cover.png",
      size: body.length,
      sha256: createHash("sha256").update(body).digest("hex"),
      contentType: "image/png",
      declaredType: "text/plain",
      originalName: "cover.png",
      status: "pending_scan",
      image: { width: 64, height: 48 },
    });
    expect(await tenantUsage(t.pool, tenant.tenantId)).toBe(body.length);
    expect(await storedObjects()).toEqual([file.id]);
  });

  it("reads JPEG dimensions past the sniffing head", async () => {
    const body = jpeg(320, 200, { metadataBytes: 6000 });
    const file = await storeFile(t.app, tenant, "scan.jpg", body);
    expect(file.contentType).toBe("image/jpeg");
    expect(file.image).toEqual({ width: 320, height: 200 });
  });

  it("refuses a second file at the same path unless overwrite is set", async () => {
    await storeFile(t.app, tenant, "docs/terms.pdf", pdf());
    const conflict = await putFile(t.app, tenant, "docs/terms.pdf", "replacement");
    expectStatus(conflict, 409);
    expect(conflict.json<ErrorResponse>().error.code).toBe("path_exists");

    const replaced = await putFile(t.app, tenant, "docs/terms.pdf", "replacement", { overwrite: true });
    expectStatus(replaced, 200);
    expect(replaced.json<FileBody>().size).toBe(11);
    expect(await tenantUsage(t.pool, tenant.tenantId)).toBe(11);
    expect(await storedObjects()).toEqual([replaced.json<FileBody>().id]);
  });

  it("treats paths as NFC, so composed and decomposed forms are one file", async () => {
    await storeFile(t.app, tenant, "caf\u00e9.txt", "one");
    const second = await putFile(t.app, tenant, "cafe\u0301.txt", "two");
    expectStatus(second, 409);
  });

  it.each([
    ["a//b.txt"],
    ["by-id/notes.txt"],
    ["dir/"],
    ["back\\slash.txt"],
  ])("rejects the path %j", async (bad) => {
    const response = await t.app.inject({
      method: "PUT",
      url: `/v1/files/${bad.split("/").map(encodeURIComponent).join("/")}`,
      headers: { ...tenant.headers, "content-type": "text/plain" },
      payload: "x",
    });
    expectStatus(response, 400);
    expect(await tenantUsage(t.pool, tenant.tenantId)).toBe(0);
  });

  it("answers 413 for a body over the limit, announced or not, and keeps nothing", async () => {
    const announced = await putFile(t.app, tenant, "big.bin", Buffer.alloc(8193));
    expectStatus(announced, 413);

    const chunked = await t.app.inject({
      method: "PUT",
      url: "/v1/files/big.bin",
      headers: { ...tenant.headers, "content-type": "application/octet-stream", "transfer-encoding": "chunked" },
      payload: Buffer.alloc(9000),
    });
    expectStatus(chunked, 413);
    expect(chunked.json<ErrorResponse>().error.code).toBe("payload_too_large");
    expect(await tenantUsage(t.pool, tenant.tenantId)).toBe(0);
    expect(await storedObjects()).toEqual([]);
  });

  it("accepts a body of exactly the limit", async () => {
    const file = await storeFile(t.app, tenant, "exact.bin", Buffer.alloc(8192, 1));
    expect(file.size).toBe(8192);
  });

  it("answers 422 when the quota has no room, for known and unknown sizes", async () => {
    await storeFile(t.app, tenant, "a.bin", Buffer.alloc(8000));
    await storeFile(t.app, tenant, "b.bin", Buffer.alloc(8000));
    const announced = await putFile(t.app, tenant, "c.bin", Buffer.alloc(5000));
    expectStatus(announced, 422);
    expect(announced.json<ErrorResponse>().error.code).toBe("quota_exceeded");

    const chunked = await t.app.inject({
      method: "PUT",
      url: "/v1/files/c.bin",
      headers: { ...tenant.headers, "transfer-encoding": "chunked" },
      payload: Buffer.alloc(5000),
    });
    expectStatus(chunked, 422);
    expect(await tenantUsage(t.pool, tenant.tenantId)).toBe(16000);
    expect((await storedObjects()).length).toBe(2);
  });

  it("stores an empty body as an empty file", async () => {
    const file = await storeFile(t.app, tenant, "empty.txt", "");
    expect(file).toMatchObject({ size: 0, contentType: "application/octet-stream" });
  });

  it("uploads a multipart form with the path before the file", async () => {
    const form = multipartBody([
      { name: "path", value: "invoices/2030-01.pdf" },
      {
        name: "file",
        filename: "C:\\Users\\clerk\\Invoice January.pdf",
        contentType: "application/pdf",
        content: pdf(),
      },
    ]);
    const response = await t.app.inject({
      method: "POST",
      url: "/v1/files",
      headers: { ...tenant.headers, "content-type": form.contentType },
      payload: form.payload,
    });
    expectStatus(response, 201);
    expect(response.json<FileBody>()).toMatchObject({
      path: "invoices/2030-01.pdf",
      contentType: "application/pdf",
      declaredType: "application/pdf",
      originalName: "Invoice January.pdf",
    });
  });

  it("refuses a multipart form whose path field comes after the file", async () => {
    const form = multipartBody([
      { name: "file", filename: "a.txt", contentType: "text/plain", content: Buffer.from("hello") },
      { name: "path", value: "a.txt" },
    ]);
    const response = await t.app.inject({
      method: "POST",
      url: "/v1/files",
      headers: { ...tenant.headers, "content-type": form.contentType },
      payload: form.payload,
    });
    expectStatus(response, 400);
  });

  it("validates the path of a multipart form like any other", async () => {
    // A form field reaches the service as sent; URLs are normalized by clients before that.
    const form = multipartBody([
      { name: "path", value: "reports/../secrets.txt" },
      { name: "file", filename: "a.txt", contentType: "text/plain", content: Buffer.from("hello") },
    ]);
    const response = await t.app.inject({
      method: "POST",
      url: "/v1/files",
      headers: { ...tenant.headers, "content-type": form.contentType },
      payload: form.payload,
    });
    expectStatus(response, 400);
    expect(response.json<ErrorResponse>().error.message).toMatch(/\.\. segments/);
  });

  it("answers 413 for an oversized multipart file", async () => {
    const form = multipartBody([
      { name: "path", value: "big.bin" },
      { name: "file", filename: "big.bin", contentType: "application/octet-stream", content: Buffer.alloc(8193) },
    ]);
    const response = await t.app.inject({
      method: "POST",
      url: "/v1/files",
      headers: { ...tenant.headers, "content-type": form.contentType },
      payload: form.payload,
    });
    expectStatus(response, 413);
    expect(await tenantUsage(t.pool, tenant.tenantId)).toBe(0);
  });

  it("refuses a JSON body on the multipart route", async () => {
    const response = await t.app.inject({
      method: "POST",
      url: "/v1/files",
      headers: tenant.headers,
      payload: { path: "a.txt" },
    });
    expectStatus(response, 400);
  });
});
