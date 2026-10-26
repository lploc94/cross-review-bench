import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { StorageError } from "../../src/domain/errors.js";
import { S3StorageDriver } from "../../src/storage/s3Driver.js";
import { FakeS3 } from "../helpers/fakeS3.js";
import { chunkedStream, collect, failingStream } from "../helpers/streams.js";
import { storageContract } from "./contract.js";

storageContract("s3", async () => {
  const fake = await FakeS3.start();
  return { driver: new S3StorageDriver({ client: fake.client() }), close: () => fake.close() };
});

describe("s3 storage specifics", () => {
  let fake: FakeS3;
  let spoolDir: string;
  let driver: S3StorageDriver;
  const key = "t/8a1f2c3d-0000-4000-8000-000000000001/9b2e3d4c-0000-4000-8000-000000000002";

  beforeAll(async () => {
    fake = await FakeS3.start();
  });

  afterAll(async () => {
    await fake.close();
  });

  beforeEach(async () => {
    fake.objects.clear();
    fake.requests.length = 0;
    spoolDir = await mkdtemp(path.join(os.tmpdir(), "uploads-spool-test-"));
    driver = new S3StorageDriver({ client: fake.client(), spoolDir });
  });

  afterEach(async () => {
    await rm(spoolDir, { recursive: true, force: true });
  });

  it("streams a body of known length straight into one PutObject", async () => {
    await driver.put(key, chunkedStream(["abc", "def"]), { contentType: "text/plain", size: 6 });
    expect(fake.operations()).toEqual(["PutObject"]);
    const request = fake.requests[0];
    expect(request?.headers["content-length"]).toBe("6");
    expect(request?.headers["x-amz-content-sha256"]).toBe("UNSIGNED-PAYLOAD");
    expect(fake.objects.get(key)?.contentType).toBe("text/plain");
    expect(await readdir(spoolDir)).toEqual([]);
  });

  it("spools a body of unknown length and removes the spool file", async () => {
    await driver.put(key, chunkedStream(["spooled ", "body"]), { contentType: "text/plain" });
    expect(fake.objects.get(key)?.body.toString()).toBe("spooled body");
    expect(await readdir(spoolDir)).toEqual([]);
  });

  it("removes the spool file when the source fails", async () => {
    await expect(
      driver.put(key, failingStream([Buffer.from("half")], new Error("reset")), { contentType: "text/plain" }),
    ).rejects.toThrow("reset");
    expect(await readdir(spoolDir)).toEqual([]);
    expect(fake.operations()).toEqual([]);
  });

  it("surfaces S3 errors with their code", async () => {
    fake.failNext("PutObject", { status: 503, code: "SlowDown", message: "Reduce your request rate." });
    const error = await driver
      .put(key, chunkedStream(["x"]), { contentType: "text/plain", size: 1 })
      .catch((err: unknown) => err);
    expect(error).toBeInstanceOf(StorageError);
    expect((error as StorageError).storageCode).toBe("SlowDown");
    expect(fake.objects.has(key)).toBe(false);
  });

  it("is refused by S3 when signed with the wrong secret", async () => {
    const wrong = new S3StorageDriver({
      client: fake.client({ credentials: { ...fake.credentials, secretAccessKey: "not-the-secret" } }),
    });
    const error = await wrong.head(key).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(StorageError);
    expect((error as StorageError).storageCode).toBe("HTTP403");
  });

  it("assembles parts from a listing that spans several pages", async () => {
    const session = "1c2d3e4f-0000-4000-8000-000000000003";
    for (let index = 1; index <= 3; index++) {
      await driver.stagePart(session, index, chunkedStream([`p${index};`]));
    }
    // Objects from another session sort between and must not be picked up.
    await driver.stagePart("1c2d3e4f-0000-4000-8000-000000000004", 1, chunkedStream(["other"]));
    await driver.assemble(session, key, 3);
    expect((await collect(await driver.get(key))).toString()).toBe("p1;p2;p3;");
    expect(await driver.listStaging()).toEqual([session, "1c2d3e4f-0000-4000-8000-000000000004"]);
  });

  it("encodes keys with reserved characters", async () => {
    fake.putObject("staging/odd key+(1)", Buffer.from("x"));
    const client = fake.client();
    expect(await client.headObject("staging/odd key+(1)")).toMatchObject({ size: 1 });
    await expect(client.headObject("staging/../escape")).rejects.toThrow(/invalid object key/);
  });
});

describe("fake S3 multipart API", () => {
  let fake: FakeS3;

  beforeAll(async () => {
    fake = await FakeS3.start();
  });

  afterAll(async () => {
    await fake.close();
  });

  it("creates, uploads, lists and completes a multipart upload", async () => {
    fake.minPartSize = 4;
    const created = await fake.signedFetch("POST", "big/object", { query: "uploads" });
    const uploadId = /<UploadId>([^<]+)<\/UploadId>/.exec(await created.text())?.[1] ?? "";
    const etags: string[] = [];
    for (const [index, body] of ["part1", "part2", "z"].entries()) {
      const response = await fake.signedFetch("PUT", "big/object", {
        query: `partNumber=${index + 1}&uploadId=${uploadId}`,
        body: Buffer.from(body),
      });
      expect(response.status).toBe(200);
      etags.push(response.headers.get("etag") ?? "");
    }
    const listing = await fake.signedFetch("GET", null, { query: "uploads" });
    expect(await listing.text()).toContain(`<UploadId>${uploadId}</UploadId>`);
    const parts = etags
      .map((etag, i) => `<Part><PartNumber>${i + 1}</PartNumber><ETag>${etag}</ETag></Part>`)
      .join("");
    const completed = await fake.signedFetch("POST", "big/object", {
      query: `uploadId=${uploadId}`,
      body: Buffer.from(`<CompleteMultipartUpload>${parts}</CompleteMultipartUpload>`),
    });
    expect(completed.status).toBe(200);
    expect(fake.objects.get("big/object")?.body.toString()).toBe("part1part2z");
    expect(fake.uploads.size).toBe(0);
  });

  it("refuses parts below the minimum size and aborts uploads", async () => {
    fake.minPartSize = 1024;
    const created = await fake.signedFetch("POST", "small/object", { query: "uploads" });
    const uploadId = /<UploadId>([^<]+)<\/UploadId>/.exec(await created.text())?.[1] ?? "";
    const etags: string[] = [];
    for (const [index, body] of ["a", "b"].entries()) {
      const response = await fake.signedFetch("PUT", "small/object", {
        query: `partNumber=${index + 1}&uploadId=${uploadId}`,
        body: Buffer.from(body),
      });
      etags.push(response.headers.get("etag") ?? "");
    }
    const parts = etags
      .map((etag, i) => `<Part><PartNumber>${i + 1}</PartNumber><ETag>${etag}</ETag></Part>`)
      .join("");
    const completed = await fake.signedFetch("POST", "small/object", {
      query: `uploadId=${uploadId}`,
      body: Buffer.from(`<CompleteMultipartUpload>${parts}</CompleteMultipartUpload>`),
    });
    expect(completed.status).toBe(400);
    expect(await completed.text()).toContain("EntityTooSmall");
    const aborted = await fake.signedFetch("DELETE", "small/object", { query: `uploadId=${uploadId}` });
    expect(aborted.status).toBe(204);
    expect(fake.uploads.has(uploadId)).toBe(false);
  });
});
