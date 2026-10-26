import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildTestApp, type TestApp } from "../helpers/app.js";
import { createTenant, expectStatus, markAvailable, storeFile, type TestTenant } from "../helpers/fixtures.js";

const BODY = Array.from({ length: 100 }, (_, i) => String.fromCharCode(97 + (i % 26))).join("");

describe("Content-Length of partial downloads", () => {
  let t: TestApp;
  let tenant: TestTenant;
  let fileId: string;

  beforeEach(async () => {
    t = await buildTestApp();
    tenant = await createTenant(t.pool, t.clock);
    const file = await storeFile(t.app, tenant, "data/hundred.bin", BODY);
    await markAvailable(t.pool, file.id);
    fileId = file.id;
  });

  afterEach(async () => {
    await t.close();
  });

  it("matches the number of bytes in the range", async () => {
    for (const url of ["/v1/files/data/hundred.bin", `/v1/files/by-id/${fileId}`]) {
      const response = await t.app.inject({ url, headers: { ...tenant.headers, range: "bytes=0-9" } });
      expectStatus(response, 206);
      expect(response.headers["content-range"]).toBe("bytes 0-9/100");
      expect(response.headers["content-length"]).toBe("10");
      expect(response.rawPayload.length).toBe(10);
      expect(response.body).toBe(BODY.slice(0, 10));
    }
  });

  it("matches for a one-byte range and an open range", async () => {
    const one = await t.app.inject({
      url: "/v1/files/data/hundred.bin",
      headers: { ...tenant.headers, range: "bytes=42-42" },
    });
    expectStatus(one, 206);
    expect(one.headers["content-length"]).toBe("1");
    expect(one.body).toBe(BODY.slice(42, 43));

    const open = await t.app.inject({
      url: "/v1/files/data/hundred.bin",
      headers: { ...tenant.headers, range: "bytes=90-" },
    });
    expectStatus(open, 206);
    expect(open.headers["content-length"]).toBe("10");
    expect(open.body).toBe(BODY.slice(90));
  });
});
