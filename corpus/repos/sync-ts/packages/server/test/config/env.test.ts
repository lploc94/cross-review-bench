import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig, loadScriptConfig } from "../../src/config/env.js";

const BASE = { DATABASE_URL: "postgres://sync:sync@localhost:5432/sync" };

describe("loadConfig", () => {
  it("applies the defaults", () => {
    const config = loadConfig(BASE);
    expect(config.port).toBe(3000);
    expect(config.sync).toEqual({
      serverNodeId: "server",
      maxClockDriftMs: 60_000,
      pushMaxMutations: 500,
      pullMaxLimit: 1_000,
      pullDefaultLimit: 200,
    });
    expect(config.bodyLimitBytes).toBe(32 * 1024 * 1024);
  });

  it("reads and converts every variable", () => {
    const config = loadConfig({
      ...BASE,
      PORT: "8080",
      SERVER_NODE_ID: "sync-eu-1",
      MAX_CLOCK_DRIFT_MS: "5000",
      PUSH_MAX_MUTATIONS: "50",
      PULL_MAX_LIMIT: "100",
      PULL_DEFAULT_LIMIT: "10",
    });
    expect(config.port).toBe(8080);
    expect(config.sync.serverNodeId).toBe("sync-eu-1");
    expect(config.sync.maxClockDriftMs).toBe(5000);
    expect(config.sync.pushMaxMutations).toBe(50);
    expect(config.sync.pullMaxLimit).toBe(100);
    expect(config.sync.pullDefaultLimit).toBe(10);
  });

  it("treats blank variables as unset", () => {
    expect(loadConfig({ ...BASE, PORT: "  ", LOG_LEVEL: "" }).port).toBe(3000);
  });

  it("lists every problem at once", () => {
    try {
      loadConfig({ DATABASE_URL: "mysql://x", PORT: "-1", SERVER_NODE_ID: "Server One" });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      const issues = (err as ConfigError).issues.join("\n");
      expect(issues).toContain("DATABASE_URL");
      expect(issues).toContain("PORT");
      expect(issues).toContain("SERVER_NODE_ID");
    }
  });

  it("requires DATABASE_URL", () => {
    expect(() => loadConfig({})).toThrow(/DATABASE_URL/);
  });

  it("refuses a default pull limit above the maximum", () => {
    expect(() => loadConfig({ ...BASE, PULL_MAX_LIMIT: "100", PULL_DEFAULT_LIMIT: "101" })).toThrow(
      /PULL_DEFAULT_LIMIT/,
    );
  });

  it("refuses out-of-range limits", () => {
    expect(() => loadConfig({ ...BASE, PUSH_MAX_MUTATIONS: "0" })).toThrow(/PUSH_MAX_MUTATIONS/);
    expect(() => loadConfig({ ...BASE, PULL_MAX_LIMIT: "1.5" })).toThrow(/PULL_MAX_LIMIT/);
  });
});

describe("loadScriptConfig", () => {
  it("needs only the database and the log level", () => {
    expect(loadScriptConfig({ ...BASE, LOG_LEVEL: "warn" })).toEqual({
      databaseUrl: BASE.DATABASE_URL,
      logLevel: "warn",
    });
  });
});
