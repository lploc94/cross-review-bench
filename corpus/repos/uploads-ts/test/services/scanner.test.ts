import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createLogger } from "../../src/infra/logger.js";
import { HttpScanner } from "../../src/services/scanner.js";
import { chunkedStream } from "../helpers/streams.js";

const logger = createLogger({ level: "silent" });

describe("HttpScanner", () => {
  let server: http.Server | null = null;

  afterEach(async () => {
    server?.closeAllConnections();
    await new Promise((resolve) => server?.close(resolve) ?? resolve(undefined));
    server = null;
  });

  async function scanningService(
    answer: (body: Buffer, res: http.ServerResponse) => void,
  ): Promise<string> {
    server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => answer(Buffer.concat(chunks), res));
    });
    await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}/scan`;
  }

  it("sends the bytes and reads the verdict", async () => {
    const received: string[] = [];
    const url = await scanningService((body, res) => {
      received.push(body.toString());
      const infected = body.includes("EICAR");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ result: infected ? "infected" : "clean" }));
    });
    const scanner = new HttpScanner({ url, timeoutMs: 2000, logger });
    expect(await scanner.scan(chunkedStream(["harmless ", "text"]))).toBe("clean");
    expect(await scanner.scan(chunkedStream(["EICAR test"]))).toBe("infected");
    expect(received).toEqual(["harmless text", "EICAR test"]);
  });

  it.each([
    [500, '{"result":"clean"}'],
    [200, '{"result":"maybe"}'],
    [200, "clean"],
  ])("treats status %i with body %j as an error verdict", async (status, text) => {
    const url = await scanningService((_body, res) => {
      res.writeHead(status);
      res.end(text);
    });
    expect(await new HttpScanner({ url, timeoutMs: 2000, logger }).scan(chunkedStream(["x"]))).toBe("error");
  });

  it("gives up after the timeout", async () => {
    const url = await scanningService(() => undefined);
    const scanner = new HttpScanner({ url, timeoutMs: 100, logger });
    expect(await scanner.scan(chunkedStream(["x"]))).toBe("error");
  });

  it("reports an unreachable service as an error verdict", async () => {
    const url = await scanningService(() => undefined);
    server?.closeAllConnections();
    await new Promise((resolve) => server?.close(resolve));
    server = null;
    expect(await new HttpScanner({ url, timeoutMs: 1000, logger }).scan(chunkedStream(["x"]))).toBe("error");
  });
});
