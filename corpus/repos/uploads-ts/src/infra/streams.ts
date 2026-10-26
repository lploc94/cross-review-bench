import { createHash, type Hash } from "node:crypto";
import { Readable, Transform, type TransformCallback } from "node:stream";

/**
 * Stream building blocks for the upload and download paths. Everything here streams: a body is
 * never held in memory beyond the bounded head a meter keeps for sniffing.
 */

export interface UploadMeterOptions {
  /** More bytes than this fail the stream with `tooLarge()`. */
  readonly maxBytes: number;
  /** How many leading bytes to keep for content sniffing. */
  readonly headBytes: number;
  readonly tooLarge: () => Error;
}

/**
 * A pass-through that counts the bytes, hashes them with sha256, keeps the first `headBytes`, and
 * fails as soon as the total passes `maxBytes`, before the offending chunk reaches the sink.
 */
export class UploadMeter extends Transform {
  private readonly options: UploadMeterOptions;
  private readonly hash: Hash = createHash("sha256");
  private readonly headChunks: Buffer[] = [];
  private headLength = 0;
  private digest: string | null = null;
  private count = 0;

  constructor(options: UploadMeterOptions) {
    super();
    this.options = options;
  }

  get bytes(): number {
    return this.count;
  }

  /** The first bytes of the stream (at most `headBytes`). */
  get head(): Buffer {
    return Buffer.concat(this.headChunks, this.headLength);
  }

  /** Whether the head holds the whole stream, i.e. the stream ended within `headBytes`. */
  get headIsComplete(): boolean {
    return this.digest !== null && this.count === this.headLength;
  }

  /** Hex sha256 of everything that passed; available once the stream has ended. */
  get sha256(): string {
    if (this.digest === null) {
      throw new Error("the sha256 is known only after the stream has ended");
    }
    return this.digest;
  }

  override _transform(chunk: unknown, _encoding: BufferEncoding, callback: TransformCallback): void {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    const total = this.count + buffer.length;
    if (total > this.options.maxBytes) {
      callback(this.options.tooLarge());
      return;
    }
    this.count = total;
    this.hash.update(buffer);
    const room = this.options.headBytes - this.headLength;
    if (room > 0) {
      const slice = buffer.length > room ? buffer.subarray(0, room) : buffer;
      // Copy: the producer may reuse its buffer once the chunk has been passed on.
      this.headChunks.push(Buffer.from(slice));
      this.headLength += slice.length;
    }
    callback(null, buffer);
  }

  override _flush(callback: TransformCallback): void {
    this.digest = this.hash.digest("hex");
    callback();
  }
}

/** Counts the bytes that pass through. */
export class ByteCounter extends Transform {
  bytes = 0;

  override _transform(chunk: unknown, _encoding: BufferEncoding, callback: TransformCallback): void {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    this.bytes += buffer.length;
    callback(null, buffer);
  }
}

/**
 * Read at most `maxBytes` from the start of `stream`, then destroy it: the rest of the stream is
 * never read and its resources are released whether or not reading succeeded.
 */
export async function readPrefix(stream: Readable, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let length = 0;
  try {
    if (maxBytes <= 0) return Buffer.alloc(0);
    for await (const chunk of stream) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
      const room = maxBytes - length;
      const slice = buffer.length > room ? buffer.subarray(0, room) : buffer;
      chunks.push(slice);
      length += slice.length;
      if (length >= maxBytes) break;
    }
    return Buffer.concat(chunks, length);
  } finally {
    stream.destroy();
  }
}

/**
 * Read a whole stream into memory, failing once it passes `maxBytes`. Only for small bodies whose
 * size the caller bounds (error documents, XML listings).
 */
export async function readAll(stream: Readable, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let length = 0;
  try {
    for await (const chunk of stream) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
      length += buffer.length;
      if (length > maxBytes) {
        throw new Error(`body exceeds ${maxBytes} bytes`);
      }
      chunks.push(buffer);
    }
    return Buffer.concat(chunks, length);
  } finally {
    stream.destroy();
  }
}

/**
 * One readable made of several opened one after another. Each source is opened only when the
 * previous one has ended, and destroyed when it ends, fails, or the result is destroyed early.
 */
export function concatStreams(openers: readonly (() => Promise<Readable>)[]): Readable {
  return new ConcatReadable(openers);
}

class ConcatReadable extends Readable {
  private readonly openers: readonly (() => Promise<Readable>)[];
  private next = 0;
  private current: Readable | null = null;
  private opening = false;

  constructor(openers: readonly (() => Promise<Readable>)[]) {
    super();
    this.openers = openers;
  }

  override _read(): void {
    if (this.current) {
      this.current.resume();
      return;
    }
    if (!this.opening) this.openNext();
  }

  private openNext(): void {
    const open = this.openers[this.next];
    if (open === undefined) {
      this.push(null);
      return;
    }
    this.next++;
    this.opening = true;
    open().then(
      (source) => {
        this.opening = false;
        if (this.destroyed) {
          source.destroy();
          return;
        }
        this.attach(source);
      },
      (err: unknown) => {
        this.opening = false;
        this.destroy(err instanceof Error ? err : new Error(String(err)));
      },
    );
  }

  private attach(source: Readable): void {
    this.current = source;
    source.on("data", (chunk: Buffer | Uint8Array | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (!this.push(buffer)) source.pause();
    });
    source.once("end", () => {
      this.detach(source);
      this.openNext();
    });
    source.once("error", (err: Error) => {
      this.detach(source);
      this.destroy(err);
    });
  }

  private detach(source: Readable): void {
    source.removeAllListeners("data");
    source.destroy();
    if (this.current === source) this.current = null;
  }

  override _destroy(err: Error | null, callback: (error?: Error | null) => void): void {
    const source = this.current;
    this.current = null;
    if (source) {
      source.removeAllListeners("data");
      source.on("error", () => undefined);
      source.destroy();
    }
    callback(err);
  }
}

/**
 * Fail `stream` with `makeError()` if it is still flowing after `ms` milliseconds. Returns the
 * function that cancels the timer; call it once the stream is done either way.
 */
export function failAfter(stream: Readable, ms: number, makeError: () => Error): () => void {
  const timer = setTimeout(() => {
    if (!stream.destroyed && !stream.readableEnded) stream.destroy(makeError());
  }, ms);
  timer.unref();
  return () => clearTimeout(timer);
}
