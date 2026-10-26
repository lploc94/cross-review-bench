import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { createLogger, redactUrl } from "../../src/infra/logger.js";

function captured(): { lines: string[]; stream: Writable } {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      lines.push(chunk.toString("utf8"));
      callback();
    },
  });
  return { lines, stream };
}

describe("logger", () => {
  it("redacts signed-URL signatures in request URLs", () => {
    expect(redactUrl("/v1/public/abc?exp=1900000000&sig=deadbeef")).toBe(
      "/v1/public/abc?exp=1900000000&sig=[redacted]",
    );
    expect(redactUrl("/v1/files?limit=5")).toBe("/v1/files?limit=5");
  });

  it("never writes authorization headers or signatures", () => {
    const { lines, stream } = captured();
    const logger = createLogger({ level: "info" }, stream);
    logger.info(
      {
        req: { method: "GET", url: "/v1/public/abc?exp=1&sig=feedface", headers: { authorization: "Bearer up_x" } },
        headers: { authorization: "Bearer up_y" },
        query: { sig: "cafebabe" },
      },
      "request",
    );
    const output = lines.join("");
    expect(output).toContain("sig=[redacted]");
    expect(output).not.toContain("feedface");
    expect(output).not.toContain("cafebabe");
    expect(output).not.toContain("up_x");
    expect(output).not.toContain("up_y");
  });
});
