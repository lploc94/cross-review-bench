import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "../../src/config/env.js";

const base = {
  DATABASE_URL: "postgres://user:pass@db.invalid:5432/uploads",
  SIGNING_SECRET: "a-signing-secret-of-at-least-32-chars",
};

describe("loadConfig", () => {
  it("applies defaults", () => {
    const config = loadConfig(base);
    expect(config.port).toBe(3000);
    expect(config.storage).toEqual({ driver: "local", localRoot: ".data/storage", s3: null });
    expect(config.uploads.maxUploadBytes).toBe(100 * 1024 * 1024);
    expect(config.scanner.kind).toBe("noop");
    expect(config.listMaxLimit).toBe(1000);
  });

  it("lists every problem at once and treats blank values as unset", () => {
    let error: unknown;
    try {
      loadConfig({ DATABASE_URL: "mysql://nope", SIGNING_SECRET: "short", PORT: "  ", MAX_UPLOAD_BYTES: "1e6" });
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(ConfigError);
    const issues = (error as ConfigError).issues.join("\n");
    expect(issues).toMatch(/DATABASE_URL/);
    expect(issues).toMatch(/SIGNING_SECRET/);
    expect(issues).toMatch(/MAX_UPLOAD_BYTES/);
    expect(issues).not.toMatch(/PORT/);
  });

  it("requires the S3 settings with the s3 driver", () => {
    expect(() => loadConfig({ ...base, STORAGE_DRIVER: "s3", S3_BUCKET: "media" })).toThrow(
      /S3_ENDPOINT: is required when STORAGE_DRIVER=s3/,
    );
    const config = loadConfig({
      ...base,
      STORAGE_DRIVER: "s3",
      S3_ENDPOINT: "http://objects.invalid:9000/",
      S3_REGION: "eu-test-1",
      S3_BUCKET: "media-files",
      S3_ACCESS_KEY_ID: "AKIDEXAMPLE",
      S3_SECRET_ACCESS_KEY: "secret",
    });
    expect(config.storage.s3?.endpoint).toBe("http://objects.invalid:9000");
  });

  it("checks cross-field rules", () => {
    expect(() => loadConfig({ ...base, SCANNER: "http" })).toThrow(/SCANNER_URL/);
    expect(() => loadConfig({ ...base, SCAN_BACKOFF_BASE_S: "100", SCAN_BACKOFF_MAX_S: "10" })).toThrow(
      /SCAN_BACKOFF_MAX_S/,
    );
    expect(() => loadConfig({ ...base, MAX_UPLOAD_BYTES: String(6 * 1024 ** 3) })).toThrow(
      /MAX_UPLOAD_BYTES/,
    );
  });
});
