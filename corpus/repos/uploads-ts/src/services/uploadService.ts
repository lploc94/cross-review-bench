import { randomUUID } from "node:crypto";
import { pipeline, type Readable } from "node:stream";
import type { Pool } from "../db/pool.js";
import { withTransaction } from "../db/tx.js";
import { PathConflictError, PayloadTooLargeError, QuotaExceededError } from "../domain/errors.js";
import type { FileRecord } from "../domain/file.js";
import { normalizePath, originalNameFrom, storageKeyFor } from "../domain/paths.js";
import { normalizeDeclaredType, OCTET_STREAM, SNIFF_BYTES } from "../domain/sniff.js";
import type { Clock } from "../infra/clock.js";
import type { Logger } from "../infra/logger.js";
import { UploadMeter } from "../infra/streams.js";
import * as files from "../repositories/fileRepo.js";
import * as tenants from "../repositories/tenantRepo.js";
import type { StorageDriver } from "../storage/driver.js";
import type { FileCatalog } from "./fileCatalog.js";

export interface DirectUpload {
  readonly tenantId: string;
  /** The path as the client sent it; validated here. */
  readonly path: string;
  readonly overwrite: boolean;
  /** The client's Content-Type for the bytes, kept for reference. */
  readonly declaredType?: string;
  /** The file name the client sent (multipart), if any. */
  readonly clientFileName?: string;
  /** The body's length when the client announced it (Content-Length). */
  readonly size?: number;
  readonly body: Readable;
}

export interface UploadOutcome {
  readonly file: FileRecord;
  /** Whether an existing file at the path was replaced. */
  readonly replaced: boolean;
}

export interface UploadServiceDeps {
  readonly pool: Pool;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly storage: StorageDriver;
  readonly catalog: FileCatalog;
  readonly maxUploadBytes: number;
}

/**
 * Single-request uploads (PUT with a raw body, POST multipart). The body streams through a meter
 * (count, sha256, sniffing head, size limit) into the storage driver and is never held in memory.
 *
 * Quota: with a known size the bytes are reserved before anything is written; otherwise they are
 * reserved once the body has been stored and its size is known. Any failure releases what was
 * reserved and removes the stored object.
 */
export class UploadService {
  private readonly deps: UploadServiceDeps;

  constructor(deps: UploadServiceDeps) {
    this.deps = deps;
  }

  private tooLarge = (): PayloadTooLargeError => new PayloadTooLargeError(this.deps.maxUploadBytes);

  async upload(input: DirectUpload): Promise<UploadOutcome> {
    try {
      return await this.store(input);
    } catch (err) {
      // Whatever failed, the request body is no longer wanted.
      input.body.destroy();
      throw err;
    }
  }

  private async store(input: DirectUpload): Promise<UploadOutcome> {
    const { pool, logger, storage, catalog } = this.deps;
    const path = normalizePath(input.path);
    if (input.size !== undefined && input.size > this.deps.maxUploadBytes) {
      throw this.tooLarge();
    }
    if (!input.overwrite && (await files.findLiveFileByPath(pool, input.tenantId, path))) {
      throw new PathConflictError(path);
    }

    let reservedBytes: number | null = null;
    if (input.size !== undefined) {
      if (!(await tenants.reserveBytes(pool, input.tenantId, input.size))) {
        throw new QuotaExceededError(input.size);
      }
      reservedBytes = input.size;
    }

    const fileId = randomUUID();
    const storageKey = storageKeyFor(input.tenantId, fileId);
    let committed = false;
    try {
      const meter = new UploadMeter({
        maxBytes: this.deps.maxUploadBytes,
        headBytes: SNIFF_BYTES,
        tooLarge: this.tooLarge,
      });
      // The callback form destroys the body when the meter fails (or the driver destroys it).
      const metered = pipeline(input.body, meter, () => undefined);
      const { bytes } = await storage.put(
        storageKey,
        metered,
        input.size === undefined ? { contentType: OCTET_STREAM } : { size: input.size, contentType: OCTET_STREAM },
      );
      if (reservedBytes === null) {
        if (!(await tenants.reserveBytes(pool, input.tenantId, bytes))) {
          throw new QuotaExceededError(bytes);
        }
        reservedBytes = bytes;
      }
      const content = await catalog.inspect(storageKey, meter.head, bytes);
      const registered = await withTransaction(pool, (client) =>
        catalog.register(client, {
          id: fileId,
          tenantId: input.tenantId,
          path,
          overwrite: input.overwrite,
          size: bytes,
          sha256: meter.sha256,
          declaredType: normalizeDeclaredType(input.declaredType),
          originalName: originalNameFrom(input.clientFileName, path),
          storageKey,
          content,
        }),
      );
      committed = true;
      if (registered.replaced) await catalog.removeObjectOf(registered.replaced);
      logger.info(
        { tenantId: input.tenantId, fileId, bytes, replaced: registered.replaced !== null },
        "file stored",
      );
      return { file: registered.file, replaced: registered.replaced !== null };
    } finally {
      if (!committed) {
        // The driver leaves no partial object when a write fails, but a write that succeeded
        // before a later step failed leaves a whole one: remove it either way.
        await catalog.discardObject(storageKey);
        if (reservedBytes !== null) await this.releaseQuietly(input.tenantId, reservedBytes);
      }
    }
  }

  private async releaseQuietly(tenantId: string, bytes: number): Promise<void> {
    try {
      await tenants.releaseBytes(this.deps.pool, tenantId, bytes, this.deps.logger);
    } catch (err) {
      this.deps.logger.error({ err, tenantId, bytes }, "could not release the reservation of a failed upload");
    }
  }
}
