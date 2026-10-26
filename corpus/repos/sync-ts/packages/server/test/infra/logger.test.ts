import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { createLogger } from "../../src/infra/logger.js";

function capture() {
  const lines: Record<string, unknown>[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      lines.push(JSON.parse(chunk.toString()) as Record<string, unknown>);
      callback();
    },
  });
  return { lines, logger: createLogger({ level: "info" }, stream) };
}

describe("logger", () => {
  it("redacts authorization headers and tokens", () => {
    const { lines, logger } = capture();
    logger.info({ headers: { authorization: "Bearer sd_secret" }, token: "sd_secret" }, "request");
    expect(JSON.stringify(lines[0])).not.toContain("sd_secret");
    expect(lines[0]).toMatchObject({ headers: { authorization: "[redacted]" }, token: "[redacted]" });
  });

  it("logs requests without their headers", () => {
    const { lines, logger } = capture();
    logger.info({ req: { method: "GET", url: "/v1/sync/pull", headers: { authorization: "Bearer x" } } }, "in");
    expect(lines[0]?.req).toEqual({ method: "GET", url: "/v1/sync/pull" });
  });

  it("writes the level as a label", () => {
    const { lines, logger } = capture();
    logger.warn("careful");
    expect(lines[0]).toMatchObject({ level: "warn", msg: "careful", name: "sync-server" });
  });
});
