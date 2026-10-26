import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { S3StorageDriver } from "../../src/storage/s3Driver.js";
import { buildTestApp, type TestApp } from "../helpers/app.js";
import { FakeS3 } from "../helpers/fakeS3.js";
import {
  createTenant,
  expectStatus,
  putFile,
  storeFile,
  tenantUsage,
  type ErrorResponse,
  type FileBody,
  type SessionBody,
  type TestTenant,
} from "../helpers/fixtures.js";
import { gif } from "../helpers/images.js";

describe("the application on S3 storage", () => {
  let fake: FakeS3;
  let t: TestApp;
  let tenant: TestTenant;

  beforeAll(async () => {
    fake = await FakeS3.start();
  });

  afterAll(async () => {
    await fake.close();
  });

  beforeEach(async () => {
    fake.objects.clear();
    fake.requests.length = 0;
    t = await buildTestApp({ storage: new S3StorageDriver({ client: fake.client() }) });
    tenant = await createTenant(t.pool, t.clock);
  });

  afterEach(async () => {
    await t.close();
  });

  it("stores uploads as objects keyed by tenant and file id, and serves them once scanned", async () => {
    const body = gif(12, 9);
    const file = await storeFile(t.app, tenant, "icons/dot.gif", body);
    expect(file).toMatchObject({ contentType: "image/gif", image: { width: 12, height: 9 } });
    expect([...fake.objects.keys()]).toEqual([`t/${tenant.tenantId}/${file.id}`]);

    t.scanner.next("clean");
    await t.scanWorker.runOnce();
    const response = await t.app.inject({ url: "/v1/files/icons/dot.gif", headers: tenant.headers });
    expectStatus(response, 200);
    expect(response.rawPayload).toEqual(body);
  });

  it("assembles resumable chunks from staging and removes them", async () => {
    const created = await t.app.inject({
      method: "POST",
      url: "/v1/uploads",
      headers: tenant.headers,
      payload: { path: "logs/run.txt", size: 9 },
    });
    const session = created.json<SessionBody>();
    for (const [offset, chunk] of [[0, "abc"], [3, "def"], [6, "ghi"]] as const) {
      const response = await t.app.inject({
        method: "PATCH",
        url: `/v1/uploads/${session.id}`,
        headers: { ...tenant.headers, "upload-offset": String(offset), "content-type": "application/octet-stream" },
        payload: chunk,
      });
      expectStatus(response, 204);
    }
    expect([...fake.objects.keys()].filter((key) => key.startsWith("staging/"))).toHaveLength(3);
    const completed = await t.app.inject({
      method: "POST",
      url: `/v1/uploads/${session.id}/complete`,
      headers: tenant.headers,
    });
    expectStatus(completed, 201);
    const file = completed.json<FileBody>();
    expect(fake.objects.get(`t/${tenant.tenantId}/${file.id}`)?.body.toString()).toBe("abcdefghi");
    expect([...fake.objects.keys()].filter((key) => key.startsWith("staging/"))).toEqual([]);
  });

  it("answers 502 and keeps no reservation when S3 refuses the object", async () => {
    fake.failNext("PutObject", { status: 500, code: "InternalError", message: "bucket internals" });
    const response = await putFile(t.app, tenant, "a.txt", "content");
    expectStatus(response, 502);
    const error = response.json<ErrorResponse>().error;
    expect(error).toEqual({
      code: "storage_error",
      message: "the storage backend failed",
      details: { storageCode: "InternalError" },
    });
    expect(await tenantUsage(t.pool, tenant.tenantId)).toBe(0);
  });

  it("keeps the deleted file's row for the cleanup job when S3 cannot delete the object", async () => {
    const file = await storeFile(t.app, tenant, "a.txt", "content");
    fake.failNext("DeleteObject", { status: 503, code: "SlowDown" });
    const deleted = await t.app.inject({ method: "DELETE", url: "/v1/files/a.txt", headers: tenant.headers });
    expectStatus(deleted, 204);
    expect(fake.objects.has(`t/${tenant.tenantId}/${file.id}`)).toBe(true);

    t.clock.advanceSeconds(t.config.cleanup.deletedGraceSeconds);
    expect((await t.cleanup.runOnce()).purgedObjects).toBe(1);
    expect(fake.objects.size).toBe(0);
  });
});
