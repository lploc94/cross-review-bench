import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "../../src/config/env.js";

const REQUIRED = {
  DATABASE_URL: "postgres://ledger:ledger@db.internal:5432/ledger",
  REDIS_URL: "redis://cache.internal:6379/0",
};

describe("loadConfig", () => {
  it("applies defaults for everything but the connection strings", () => {
    const config = loadConfig(REQUIRED);
    expect(config).toMatchObject({
      nodeEnv: "development",
      port: 3000,
      rateLimitPerMinute: 600,
      outbox: { batchSize: 50, pollIntervalMs: 1000, backoffBaseMs: 5000, backoffMaxMs: 3_600_000 },
      webhookTimeoutMs: 5000,
    });
  });

  it("parses numeric variables and treats blank ones as unset", () => {
    const config = loadConfig({ ...REQUIRED, PORT: "8080", RATE_LIMIT_PER_MINUTE: " ", OUTBOX_BATCH_SIZE: "10" });
    expect(config.port).toBe(8080);
    expect(config.rateLimitPerMinute).toBe(600);
    expect(config.outbox.batchSize).toBe(10);
  });

  it("reports every invalid variable at once", () => {
    let error: unknown;
    try {
      loadConfig({ REDIS_URL: "http://wrong", PORT: "eighty", LOG_LEVEL: "loud" });
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(ConfigError);
    const issues = (error as ConfigError).issues.join("\n");
    for (const name of ["DATABASE_URL", "REDIS_URL", "PORT", "LOG_LEVEL"]) {
      expect(issues).toContain(name);
    }
  });

  it("requires the backoff cap to be at least the base delay", () => {
    expect(() =>
      loadConfig({ ...REQUIRED, OUTBOX_BACKOFF_BASE_MS: "10000", OUTBOX_BACKOFF_MAX_MS: "5000" }),
    ).toThrow(/OUTBOX_BACKOFF_MAX_MS/);
  });
});
