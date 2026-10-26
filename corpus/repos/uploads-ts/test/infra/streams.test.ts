import { createHash } from "node:crypto";
import { PassThrough, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { describe, expect, it } from "vitest";
import { concatStreams, readPrefix, UploadMeter } from "../../src/infra/streams.js";
import { chunkedStream, collect, failingStream, repeatedChunks } from "../helpers/streams.js";

class TooLarge extends Error {}

function meter(maxBytes: number, headBytes = 8): UploadMeter {
  return new UploadMeter({ maxBytes, headBytes, tooLarge: () => new TooLarge("too large") });
}

function sink(): Writable & { bytes: number } {
  const target = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      target.bytes += chunk.length;
      callback();
    },
  }) as Writable & { bytes: number };
  target.bytes = 0;
  return target;
}

describe("UploadMeter", () => {
  it("counts, hashes and keeps the head across chunk boundaries", async () => {
    const m = meter(100);
    await pipeline(chunkedStream(["abc", "defg", "hijkl"]), m, sink());
    expect(m.bytes).toBe(12);
    expect(m.head.toString()).toBe("abcdefgh");
    expect(m.sha256).toBe(createHash("sha256").update("abcdefghijkl").digest("hex"));
    expect(m.headIsComplete).toBe(false);
  });

  it("accepts exactly the limit and fails on the byte after it, before the sink sees it", async () => {
    const exact = meter(12);
    await pipeline(chunkedStream(repeatedChunks(3, 4)), exact, sink());
    expect(exact.bytes).toBe(12);

    const over = meter(12);
    const target = sink();
    await expect(pipeline(chunkedStream(repeatedChunks(4, 4)), over, target)).rejects.toBeInstanceOf(TooLarge);
    expect(target.bytes).toBe(12);
  });

  it("has a complete head for bodies shorter than the head size", async () => {
    const m = meter(100, 4096);
    await pipeline(chunkedStream(["short"]), m, sink());
    expect(m.headIsComplete).toBe(true);
  });
});

describe("stream helpers", () => {
  it("readPrefix reads only what it needs and destroys the source", async () => {
    const source = new PassThrough();
    source.write(Buffer.from("0123456789"));
    const prefix = await readPrefix(source, 4);
    expect(prefix.toString()).toBe("0123");
    expect(source.destroyed).toBe(true);
  });

  it("concatStreams opens each source only after the previous one ended", async () => {
    const opened: number[] = [];
    const combined = concatStreams(
      [0, 1, 2].map((index) => async () => {
        opened.push(index);
        return chunkedStream([`part${index};`]);
      }),
    );
    expect((await collect(combined)).toString()).toBe("part0;part1;part2;");
    expect(opened).toEqual([0, 1, 2]);
  });

  it("concatStreams destroys the open source when the result is destroyed early", async () => {
    const first = new PassThrough();
    first.write("data");
    const combined = concatStreams([async () => first, async () => chunkedStream(["never"])]);
    const prefix = await readPrefix(combined, 2);
    expect(prefix.toString()).toBe("da");
    await new Promise((resolve) => setImmediate(resolve));
    expect(first.destroyed).toBe(true);
  });

  it("concatStreams fails with a source's error and opens no further source", async () => {
    let openedLast = false;
    const combined = concatStreams([
      async () => chunkedStream(["ok;"]),
      async () => failingStream([Buffer.from("partial")], new Error("disk gone")),
      async () => {
        openedLast = true;
        return chunkedStream(["never"]);
      },
    ]);
    await expect(collect(combined)).rejects.toThrow("disk gone");
    expect(openedLast).toBe(false);
  });
});
