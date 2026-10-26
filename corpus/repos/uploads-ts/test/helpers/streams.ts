import { Readable } from "node:stream";

/** A stream that yields exactly these chunks, in order: chunk boundaries the test controls. */
export function chunkedStream(chunks: readonly (Buffer | string)[]): Readable {
  return Readable.from(
    chunks.map((chunk) => (typeof chunk === "string" ? Buffer.from(chunk) : chunk)),
    { objectMode: false },
  );
}

/** `chunks` chunks of `size` bytes each, filled with `byte`. */
export function repeatedChunks(chunks: number, size: number, byte = 0x61): Buffer[] {
  return Array.from({ length: chunks }, () => Buffer.alloc(size, byte));
}

/** A stream that yields `before`, then fails with `error`. */
export function failingStream(before: readonly Buffer[], error: Error): Readable {
  async function* generate(): AsyncGenerator<Buffer> {
    yield* before;
    throw error;
  }
  return Readable.from(generate(), { objectMode: false });
}

export async function collect(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}
