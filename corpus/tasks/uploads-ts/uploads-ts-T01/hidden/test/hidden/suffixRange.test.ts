import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseRange } from "../../src/api/range.js";
import { buildTestApp, type TestApp } from "../helpers/app.js";
import { createTenant, expectStatus, markAvailable, storeFile, type TestTenant } from "../helpers/fixtures.js";

const BODY = Array.from({ length: 100 }, (_, i) => String.fromCharCode(97 + (i % 26))).join("");

describe("suffix ranges", () => {
  it("parses -N as the last N bytes", () => {
    expect(parseRange("bytes=-10", 100)).toEqual({ kind: "partial", range: { start: 90, end: 99 } });
    expect(parseRange("bytes=-1", 100)).toEqual({ kind: "partial", range: { start: 99, end: 99 } });
    expect(parseRange("bytes=-200", 100)).toEqual({ kind: "partial", range: { start: 0, end: 99 } });
  });

  describe("downloads", () => {
    let t: TestApp;
    let tenant: TestTenant;

    beforeEach(async () => {
      t = await buildTestApp();
      tenant = await createTenant(t.pool, t.clock);
      const file = await storeFile(t.app, tenant, "data/hundred.bin", BODY);
      await markAvailable(t.pool, file.id);
    });

    afterEach(async () => {
      await t.close();
    });

    function download(range: string) {
      return t.app.inject({ url: "/v1/files/data/hundred.bin", headers: { ...tenant.headers, range } });
    }

    it("serves the last bytes of the file", async () => {
      const response = await download("bytes=-10");
      expectStatus(response, 206);
      expect(response.headers["content-range"]).toBe("bytes 90-99/100");
      expect(response.body).toBe(BODY.slice(90));
    });

    it("serves the whole file for a suffix longer than the file", async () => {
      const response = await download("bytes=-200");
      expectStatus(response, 206);
      expect(response.headers["content-range"]).toBe("bytes 0-99/100");
      expect(response.body).toBe(BODY);
    });
  });
});
