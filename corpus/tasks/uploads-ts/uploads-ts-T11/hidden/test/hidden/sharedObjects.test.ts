import { readdir } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { UploadBody } from "../../src/api/serializers.js";
import { buildTestApp, type TestApp } from "../helpers/app.js";
import {
  createTenant,
  expectStatus,
  markAvailable,
  putFile,
  storeFile,
  type FileBody,
  type TestTenant,
} from "../helpers/fixtures.js";

describe("files sharing one stored object", () => {
  let t: TestApp;
  let tenant: TestTenant;

  beforeEach(async () => {
    t = await buildTestApp();
    tenant = await createTenant(t.pool, t.clock);
  });

  afterEach(async () => {
    await t.close();
  });

  async function storedObjects(): Promise<string[]> {
    const root = path.join(t.storageRoot ?? "", "objects", "t", tenant.tenantId);
    return readdir(root).catch(() => []);
  }

  /** An available file and an available copy of it that shares its object. */
  async function pair(content: string): Promise<{ original: FileBody; copy: UploadBody }> {
    const original = await storeFile(t.app, tenant, "contracts/lease.txt", content);
    await markAvailable(t.pool, original.id);
    const response = await putFile(t.app, tenant, "shared/lease.txt", content);
    expect(response.statusCode).toBeLessThan(300);
    const copy = response.json<UploadBody>();
    expect(copy.deduplicated).toBe(true);
    await markAvailable(t.pool, copy.id);
    return { original, copy };
  }

  async function expectDownload(filePath: string, content: string): Promise<void> {
    const response = await t.app.inject({ url: `/v1/files/${filePath}`, headers: tenant.headers });
    expectStatus(response, 200);
    expect(response.body).toBe(content);
  }

  async function remove(filePath: string): Promise<void> {
    expectStatus(await t.app.inject({ method: "DELETE", url: `/v1/files/${filePath}`, headers: tenant.headers }), 204);
  }

  it("keeps serving the copy after the original is deleted", async () => {
    await pair("lease terms, signed copy");
    await remove("contracts/lease.txt");
    await expectDownload("shared/lease.txt", "lease terms, signed copy");
  });

  it("keeps serving the original after the copy is deleted", async () => {
    await pair("lease terms, second edition");
    await remove("shared/lease.txt");
    await expectDownload("contracts/lease.txt", "lease terms, second edition");
  });

  it("keeps serving the copy after the original is overwritten", async () => {
    await pair("lease terms, draft three");
    const replaced = await putFile(t.app, tenant, "contracts/lease.txt", "lease terms, final", { overwrite: true });
    expectStatus(replaced, 200);
    await expectDownload("shared/lease.txt", "lease terms, draft three");
  });

  it("removes the object once no file uses it", async () => {
    const { original } = await pair("lease terms, archived");
    expect(await storedObjects()).toEqual([original.id]);
    await remove("contracts/lease.txt");
    await remove("shared/lease.txt");
    expect(await storedObjects()).toEqual([]);
  });
});
