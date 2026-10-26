import type { Readable } from "node:stream";
import type { Scanner, ScanVerdict } from "../../src/services/scanner.js";

/**
 * A scanner whose verdicts the test chooses: queued verdicts are used one per call, then the
 * default. A queued "throw" makes that call throw, like a scanner with a bug. Every scanned body is recorded.
 */
export class FakeScanner implements Scanner {
  readonly scanned: Buffer[] = [];
  private readonly queue: (ScanVerdict | "throw")[] = [];
  defaultVerdict: ScanVerdict = "clean";

  next(...verdicts: (ScanVerdict | "throw")[]): this {
    this.queue.push(...verdicts);
    return this;
  }

  async scan(stream: Readable): Promise<ScanVerdict> {
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(chunk as Buffer);
    this.scanned.push(Buffer.concat(chunks));
    const verdict = this.queue.shift() ?? this.defaultVerdict;
    if (verdict === "throw") throw new Error("scanner crashed");
    return verdict;
  }
}
