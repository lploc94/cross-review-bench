import type { Readable } from "node:stream";
import { isUuid } from "../domain/paths.js";

/**
 * Where file bytes live. Keys come from `storageKeyFor` (`t/<tenant>/<file id>`); resumable
 * uploads stage their chunks per session and assemble them into a key at completion.
 *
 * Errors are StorageErrors; a missing object is a StorageError whose `isNotFound` is true.
 * Streams handed in are consumed (or destroyed on failure); streams handed out must be consumed
 * or destroyed by the caller, which releases the descriptor or connection behind them.
 */
export interface StorageDriver {
  /** `local` or `s3`, recorded on each file row. */
  readonly name: string;

  /**
   * Write `stream` to `key`, replacing any object there. The object appears whole or not at all:
   * on failure nothing is left at `key`. With `size` given, a stream of any other length fails.
   */
  put(key: string, stream: Readable, options: PutOptions): Promise<PutResult>;

  /** The object's bytes. Fails with a not-found StorageError when there is no object. */
  get(key: string): Promise<Readable>;

  /** The object's size, or null when there is no object. */
  head(key: string): Promise<ObjectInfo | null>;

  /** Remove the object. Removing a missing object succeeds. */
  delete(key: string): Promise<void>;

  /** Copy the object at `sourceKey` to `targetKey`. */
  copy(sourceKey: string, targetKey: string): Promise<void>;

  /** Store chunk number `index` (1-based) of a resumable upload, replacing a previous attempt. */
  stagePart(sessionId: string, index: number, stream: Readable): Promise<PutResult>;

  /** Concatenate parts 1…partCount of a session into the object at `key`. */
  assemble(sessionId: string, key: string, partCount: number): Promise<PutResult>;

  /** Remove every staged part of a session. Discarding an unknown session succeeds. */
  discardStaging(sessionId: string): Promise<void>;

  /** The session ids that have staged parts. */
  listStaging(): Promise<string[]>;
}

export interface PutOptions {
  readonly size?: number;
  readonly contentType: string;
}

export interface PutResult {
  readonly bytes: number;
}

export interface ObjectInfo {
  readonly size: number;
}

/** Highest part index a session may stage. */
export const MAX_PART_INDEX = 10_000;

/** Part file/object names sort in index order: `part-000001`, `part-000002`, … */
export function partName(index: number): string {
  return `part-${String(index).padStart(6, "0")}`;
}

/** Throws unless `sessionId` is a session id: staging paths are built from it. */
export function assertSessionId(sessionId: string): void {
  if (!isUuid(sessionId)) {
    throw new Error(`not a session id: ${sessionId}`);
  }
}

export function assertPartIndex(index: number): void {
  if (!Number.isInteger(index) || index < 1 || index > MAX_PART_INDEX) {
    throw new Error(`part index must be an integer from 1 to ${MAX_PART_INDEX}, got ${index}`);
  }
}

export function assertPartCount(partCount: number): void {
  if (!Number.isInteger(partCount) || partCount < 1 || partCount > MAX_PART_INDEX) {
    throw new Error(`part count must be an integer from 1 to ${MAX_PART_INDEX}, got ${partCount}`);
  }
}
