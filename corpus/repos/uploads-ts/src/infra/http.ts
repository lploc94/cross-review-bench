import { Readable } from "node:stream";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { readAll } from "./streams.js";

/** A fetch response body as a Node stream (empty when the response has none). */
export function responseStream(response: Response): Readable {
  if (!response.body) return Readable.from([]);
  return Readable.fromWeb(response.body as WebReadableStream<Uint8Array>);
}

/** A fetch response body as text, failing once it passes `maxBytes`. */
export async function readResponseText(response: Response, maxBytes: number): Promise<string> {
  return (await readAll(responseStream(response), maxBytes)).toString("utf8");
}

/** Release a response whose body is not needed, so its connection can be reused. */
export async function discardResponse(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
}
