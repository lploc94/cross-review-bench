import { createReadStream, createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { DomainError, StorageError } from "../domain/errors.js";
import { isUuid } from "../domain/paths.js";
import { ByteCounter, concatStreams } from "../infra/streams.js";
import {
  assertPartCount,
  assertPartIndex,
  assertSessionId,
  partName,
  type ObjectInfo,
  type PutOptions,
  type PutResult,
  type StorageDriver,
} from "./driver.js";
import type { S3Client } from "./s3Client.js";

/** Everything staged for resumable uploads lives under this key prefix. */
export const STAGING_PREFIX = "staging/";

/**
 * Objects in an S3 bucket, each written with a single PutObject request. PutObject needs the
 * length up front, so a stream of unknown length (a chunked request body, a resumable chunk) is
 * first spooled to a temporary file, which is removed afterwards whatever happens.
 */
export class S3StorageDriver implements StorageDriver {
  readonly name = "s3";
  private readonly client: S3Client;
  private readonly spoolDir: string;

  constructor(options: { client: S3Client; spoolDir?: string }) {
    this.client = options.client;
    this.spoolDir = options.spoolDir ?? os.tmpdir();
  }

  private stagingKey(sessionId: string, index: number): string {
    assertSessionId(sessionId);
    assertPartIndex(index);
    return `${STAGING_PREFIX}${sessionId}/${partName(index)}`;
  }

  /**
   * Copy `stream` to a temporary file, then hand a reader of it and its length to `use`. The
   * temporary directory is removed when `use` settles or the copy fails.
   */
  private async withSpooled<T>(
    stream: Readable,
    use: (file: { open: () => Readable; bytes: number }) => Promise<T>,
  ): Promise<T> {
    let directory: string | null = null;
    try {
      directory = await mkdtemp(path.join(this.spoolDir, "uploads-spool-"));
      const file = path.join(directory, "body");
      const counter = new ByteCounter();
      await pipeline(stream, counter, createWriteStream(file, { flags: "wx" }));
      return await use({ open: () => createReadStream(file), bytes: counter.bytes });
    } catch (err) {
      stream.destroy();
      if (err instanceof DomainError || !isFileSystemError(err)) throw err;
      throw new StorageError("could not spool the body to a temporary file", {
        storageCode: "SpoolFailed",
        cause: err,
      });
    } finally {
      if (directory !== null) await rm(directory, { recursive: true, force: true });
    }
  }

  private async putKnownLength(
    key: string,
    stream: Readable,
    size: number,
    contentType: string,
  ): Promise<PutResult> {
    const counter = new ByteCounter();
    stream.once("error", (err) => counter.destroy(err));
    stream.pipe(counter);
    try {
      await this.client.putObject(key, counter, { contentLength: size, contentType });
    } catch (err) {
      stream.destroy();
      throw err;
    }
    if (counter.bytes !== size) {
      // fetch refuses a body of the wrong length, so this is not reached in practice; if it ever
      // is, the object must not be kept.
      await this.client.deleteObject(key);
      throw new StorageError(`expected ${size} bytes, sent ${counter.bytes}`, {
        storageCode: "IncompleteBody",
      });
    }
    return { bytes: size };
  }

  async put(key: string, stream: Readable, options: PutOptions): Promise<PutResult> {
    if (options.size !== undefined) {
      return this.putKnownLength(key, stream, options.size, options.contentType);
    }
    return this.withSpooled(stream, (file) =>
      this.putKnownLength(key, file.open(), file.bytes, options.contentType),
    );
  }

  get(key: string): Promise<Readable> {
    return this.client.getObject(key);
  }

  async head(key: string): Promise<ObjectInfo | null> {
    const head = await this.client.headObject(key);
    return head ? { size: head.size } : null;
  }

  delete(key: string): Promise<void> {
    return this.client.deleteObject(key);
  }

  copy(sourceKey: string, targetKey: string): Promise<void> {
    return this.client.copyObject(sourceKey, targetKey);
  }

  async stagePart(sessionId: string, index: number, stream: Readable): Promise<PutResult> {
    let key: string;
    try {
      key = this.stagingKey(sessionId, index);
    } catch (err) {
      stream.destroy();
      throw err;
    }
    return this.withSpooled(stream, (file) =>
      this.putKnownLength(key, file.open(), file.bytes, "application/octet-stream"),
    );
  }

  /** Sizes of the staged parts of a session, by key. */
  private async stagedSizes(sessionId: string): Promise<Map<string, number>> {
    assertSessionId(sessionId);
    const sizes = new Map<string, number>();
    for await (const page of this.client.listAll(`${STAGING_PREFIX}${sessionId}/`)) {
      for (const object of page.objects) sizes.set(object.key, object.size);
    }
    return sizes;
  }

  async assemble(sessionId: string, key: string, partCount: number): Promise<PutResult> {
    assertPartCount(partCount);
    const sizes = await this.stagedSizes(sessionId);
    const partKeys = Array.from({ length: partCount }, (_, i) => this.stagingKey(sessionId, i + 1));
    let total = 0;
    for (const partKey of partKeys) {
      const size = sizes.get(partKey);
      if (size === undefined) throw StorageError.notFound(partKey);
      total += size;
    }
    const body = concatStreams(partKeys.map((partKey) => () => this.client.getObject(partKey)));
    return this.putKnownLength(key, body, total, "application/octet-stream");
  }

  async discardStaging(sessionId: string): Promise<void> {
    const sizes = await this.stagedSizes(sessionId);
    for (const partKey of sizes.keys()) {
      await this.client.deleteObject(partKey);
    }
  }

  async listStaging(): Promise<string[]> {
    const sessions: string[] = [];
    for await (const page of this.client.listAll(STAGING_PREFIX, "/")) {
      for (const prefix of page.commonPrefixes) {
        const id = prefix.slice(STAGING_PREFIX.length).replace(/\/$/, "");
        if (isUuid(id)) sessions.push(id);
      }
    }
    return sessions.sort();
  }
}

function isFileSystemError(err: unknown): boolean {
  return typeof err === "object" && err !== null && "syscall" in err;
}
