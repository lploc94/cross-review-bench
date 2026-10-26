import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { copyFile, mkdir, open, readdir, rename, rm, stat, unlink } from "node:fs/promises";
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

/**
 * The absolute path of `key` under `root`, refusing any key that would leave the root (`..`
 * segments, absolute keys, NUL bytes). Keys are built by the service, never taken from users;
 * this is the last line of defence if that ever changes.
 */
export function resolveInside(root: string, key: string): string {
  if (key.length === 0 || key.includes("\0")) {
    throw new StorageError(`invalid storage key ${JSON.stringify(key)}`, { storageCode: "InvalidKey" });
  }
  const base = path.resolve(root);
  const resolved = path.resolve(base, key);
  const relative = path.relative(base, resolved);
  if (
    relative === "" ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new StorageError(`storage key ${JSON.stringify(key)} leaves the storage root`, {
      storageCode: "InvalidKey",
    });
  }
  return resolved;
}

function errorCode(err: unknown): string | undefined {
  return typeof err === "object" && err !== null && "code" in err && typeof err.code === "string"
    ? err.code
    : undefined;
}

function isFileSystemError(err: unknown): boolean {
  return typeof err === "object" && err !== null && "syscall" in err;
}

/**
 * File-system failures become StorageErrors; anything else (a failing source stream, a size limit
 * enforced upstream) is passed on unchanged so the caller sees the real cause.
 */
function storageFailure(err: unknown, action: string): unknown {
  if (err instanceof DomainError || !isFileSystemError(err)) return err;
  return new StorageError(`local storage could not ${action}`, {
    storageCode: errorCode(err) ?? "LocalIOError",
    cause: err,
  });
}

/**
 * Objects as files under `<root>/objects/<key>`, staged parts under `<root>/staging/<session>/`.
 * Every write goes to a temporary file in the target's directory and is renamed into place, so
 * readers never see a partial object; the temporary file is removed when the write fails.
 */
export class LocalStorageDriver implements StorageDriver {
  readonly name = "local";
  private readonly objectsRoot: string;
  private readonly stagingRoot: string;

  constructor(options: { root: string }) {
    const root = path.resolve(options.root);
    this.objectsRoot = path.join(root, "objects");
    this.stagingRoot = path.join(root, "staging");
  }

  /** Create the storage directories; call once at startup. */
  async init(): Promise<void> {
    await mkdir(this.objectsRoot, { recursive: true });
    await mkdir(this.stagingRoot, { recursive: true });
  }

  private objectPath(key: string): string {
    return resolveInside(this.objectsRoot, key);
  }

  private sessionDir(sessionId: string): string {
    assertSessionId(sessionId);
    return resolveInside(this.stagingRoot, sessionId);
  }

  private partPath(sessionId: string, index: number): string {
    assertPartIndex(index);
    return path.join(this.sessionDir(sessionId), partName(index));
  }

  private async writeAtomically(target: string, stream: Readable, size?: number): Promise<PutResult> {
    const directory = path.dirname(target);
    const temp = path.join(directory, `.${path.basename(target)}.${randomUUID()}.tmp`);
    try {
      await mkdir(directory, { recursive: true });
      const counter = new ByteCounter();
      // pipeline propagates backpressure, and on any failure destroys every stream in it: the
      // source is released and the temporary file's descriptor closed.
      await pipeline(stream, counter, createWriteStream(temp, { flags: "wx" }));
      if (size !== undefined && counter.bytes !== size) {
        throw new StorageError(`expected ${size} bytes, received ${counter.bytes}`, {
          storageCode: "IncompleteBody",
        });
      }
      await rename(temp, target);
      return { bytes: counter.bytes };
    } catch (err) {
      stream.destroy();
      await rm(temp, { force: true });
      throw storageFailure(err, "write an object");
    }
  }

  private async openForRead(file: string, key: string): Promise<Readable> {
    try {
      const handle = await open(file, "r");
      // autoClose: the descriptor is closed when the stream ends, fails or is destroyed.
      return handle.createReadStream({ autoClose: true });
    } catch (err) {
      if (errorCode(err) === "ENOENT" || errorCode(err) === "ENOTDIR") {
        throw StorageError.notFound(key);
      }
      throw storageFailure(err, "open an object");
    }
  }

  async put(key: string, stream: Readable, options: PutOptions): Promise<PutResult> {
    let target: string;
    try {
      target = this.objectPath(key);
    } catch (err) {
      stream.destroy();
      throw err;
    }
    return this.writeAtomically(target, stream, options.size);
  }

  async get(key: string): Promise<Readable> {
    return this.openForRead(this.objectPath(key), key);
  }

  async head(key: string): Promise<ObjectInfo | null> {
    try {
      const info = await stat(this.objectPath(key));
      return info.isFile() ? { size: info.size } : null;
    } catch (err) {
      if (errorCode(err) === "ENOENT" || errorCode(err) === "ENOTDIR") return null;
      throw storageFailure(err, "stat an object");
    }
  }

  async delete(key: string): Promise<void> {
    try {
      await unlink(this.objectPath(key));
    } catch (err) {
      if (errorCode(err) === "ENOENT" || errorCode(err) === "ENOTDIR") return;
      throw storageFailure(err, "delete an object");
    }
  }

  async copy(sourceKey: string, targetKey: string): Promise<void> {
    const source = this.objectPath(sourceKey);
    const target = this.objectPath(targetKey);
    const temp = path.join(path.dirname(target), `.${path.basename(target)}.${randomUUID()}.tmp`);
    try {
      await mkdir(path.dirname(target), { recursive: true });
      await copyFile(source, temp);
      await rename(temp, target);
    } catch (err) {
      await rm(temp, { force: true });
      if (errorCode(err) === "ENOENT") {
        const sourceExists = (await this.head(sourceKey)) !== null;
        if (!sourceExists) throw StorageError.notFound(sourceKey);
      }
      throw storageFailure(err, "copy an object");
    }
  }

  async stagePart(sessionId: string, index: number, stream: Readable): Promise<PutResult> {
    let target: string;
    try {
      target = this.partPath(sessionId, index);
    } catch (err) {
      stream.destroy();
      throw err;
    }
    return this.writeAtomically(target, stream);
  }

  async assemble(sessionId: string, key: string, partCount: number): Promise<PutResult> {
    assertPartCount(partCount);
    const target = this.objectPath(key);
    const openers = Array.from({ length: partCount }, (_, i) => {
      const file = this.partPath(sessionId, i + 1);
      return () => this.openForRead(file, `staging/${sessionId}/${partName(i + 1)}`);
    });
    return this.writeAtomically(target, concatStreams(openers));
  }

  async discardStaging(sessionId: string): Promise<void> {
    try {
      await rm(this.sessionDir(sessionId), { recursive: true, force: true });
    } catch (err) {
      throw storageFailure(err, "discard staged parts");
    }
  }

  async listStaging(): Promise<string[]> {
    try {
      const entries = await readdir(this.stagingRoot, { withFileTypes: true });
      return entries
        .filter((entry) => entry.isDirectory() && isUuid(entry.name))
        .map((entry) => entry.name)
        .sort();
    } catch (err) {
      if (errorCode(err) === "ENOENT") return [];
      throw storageFailure(err, "list staged uploads");
    }
  }
}
