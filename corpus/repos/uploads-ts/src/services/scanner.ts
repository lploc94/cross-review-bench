import { Readable } from "node:stream";
import { readResponseText } from "../infra/http.js";
import type { Logger } from "../infra/logger.js";

/**
 * Malware scanning of new files. A scanner reads the whole stream and answers `clean`,
 * `infected`, or `error` when it could not decide (the scan is retried later). Implementations
 * never throw for a failed scan, and always consume or destroy the stream they are given.
 */
export type ScanVerdict = "clean" | "infected" | "error";

export interface Scanner {
  scan(stream: Readable): Promise<ScanVerdict>;
}

/** Accepts everything without reading it: for deployments without a scanning service. */
export class NoopScanner implements Scanner {
  async scan(stream: Readable): Promise<ScanVerdict> {
    stream.destroy();
    return "clean";
  }
}

/** Scanner answers are tiny JSON documents. */
const MAX_ANSWER_BYTES = 64 * 1024;

/**
 * A scanning service over HTTP: the bytes are POSTed as `application/octet-stream` to `url`, which
 * answers 200 with `{"result":"clean"}` or `{"result":"infected"}`. Any other answer, a network
 * failure or no answer within `timeoutMs` is an `error` verdict.
 */
export class HttpScanner implements Scanner {
  private readonly url: string;
  private readonly timeoutMs: number;
  private readonly logger: Logger;

  constructor(options: { url: string; timeoutMs: number; logger: Logger }) {
    this.url = options.url;
    this.timeoutMs = options.timeoutMs;
    this.logger = options.logger;
  }

  async scan(stream: Readable): Promise<ScanVerdict> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const init: RequestInit & { duplex: "half" } = {
        method: "POST",
        headers: { "content-type": "application/octet-stream" },
        body: Readable.toWeb(stream) as ReadableStream<Uint8Array>,
        duplex: "half",
        signal: controller.signal,
        redirect: "error",
      };
      const response = await fetch(this.url, init);
      const text = await readResponseText(response, MAX_ANSWER_BYTES);
      if (response.status !== 200) {
        this.logger.warn({ status: response.status }, "scanner answered with an error status");
        return "error";
      }
      const result = parseVerdict(text);
      if (result === null) {
        this.logger.warn("scanner answer is not a verdict");
        return "error";
      }
      return result;
    } catch (err) {
      this.logger.warn(
        { err, timedOut: controller.signal.aborted },
        "scanner request failed",
      );
      return "error";
    } finally {
      clearTimeout(timer);
      stream.destroy();
    }
  }
}

function parseVerdict(text: string): "clean" | "infected" | null {
  try {
    const body: unknown = JSON.parse(text);
    if (typeof body === "object" && body !== null && "result" in body) {
      if (body.result === "clean" || body.result === "infected") return body.result;
    }
    return null;
  } catch {
    return null;
  }
}
