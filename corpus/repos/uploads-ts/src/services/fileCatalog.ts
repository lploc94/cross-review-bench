import type { PoolClient, Pool } from "../db/pool.js";
import { PathConflictError } from "../domain/errors.js";
import type { FileRecord, ImageDimensions } from "../domain/file.js";
import { JPEG_SCAN_LIMIT, readImageDimensions, toImageDimensions } from "../domain/imageMeta.js";
import { sniffContentType } from "../domain/sniff.js";
import type { Clock } from "../infra/clock.js";
import type { Logger } from "../infra/logger.js";
import { readPrefix } from "../infra/streams.js";
import * as files from "../repositories/fileRepo.js";
import { isUniqueViolation } from "../repositories/mapping.js";
import * as tenants from "../repositories/tenantRepo.js";
import type { StorageDriver } from "../storage/driver.js";

export interface CatalogDeps {
  readonly pool: Pool;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly storage: StorageDriver;
}

export interface ContentInfo {
  readonly contentType: string;
  readonly image: ImageDimensions | null;
}

/** A file whose bytes are stored and inspected, ready to be recorded. */
export interface StoredFile {
  readonly id: string;
  readonly tenantId: string;
  readonly path: string;
  readonly overwrite: boolean;
  readonly size: number;
  readonly sha256: string;
  readonly declaredType: string | null;
  readonly originalName: string;
  readonly storageKey: string;
  readonly content: ContentInfo;
}

export interface RegisteredFile {
  readonly file: FileRecord;
  /** The live file that was at the path before, now soft-deleted; its object is still stored. */
  readonly replaced: FileRecord | null;
}

/** Name of the partial unique index that keeps one live file per tenant and path. */
const LIVE_PATH_INDEX = "files_tenant_path_live";

/**
 * What every way of creating a file shares once its bytes are stored: inspecting the content,
 * recording the row (replacing the file at the path when asked to), and removing storage objects
 * after the rows that referenced them are gone.
 */
export class FileCatalog {
  private readonly deps: CatalogDeps;

  constructor(deps: CatalogDeps) {
    this.deps = deps;
  }

  /**
   * Sniff the content type from the first bytes and read image dimensions. The head is normally
   * enough; a JPEG whose frame header lies further in is read again from storage, up to 64 KiB.
   */
  async inspect(storageKey: string, head: Buffer, size: number): Promise<ContentInfo> {
    const contentType = sniffContentType(head, { complete: head.length >= size });
    let result = readImageDimensions(head, contentType);
    if (result.kind === "truncated" && contentType === "image/jpeg" && size > head.length) {
      const prefix = await readPrefix(
        await this.deps.storage.get(storageKey),
        Math.min(size, JPEG_SCAN_LIMIT),
      );
      result = readImageDimensions(prefix, contentType);
    }
    return { contentType, image: toImageDimensions(result) };
  }

  /**
   * Record a stored file inside the caller's transaction. A live file at the same path is a
   * PathConflictError unless `overwrite` is set; then it is soft-deleted and its bytes released.
   * The new file's own bytes must already be reserved by the caller.
   */
  async register(client: PoolClient, stored: StoredFile): Promise<RegisteredFile> {
    const now = this.deps.clock.now();
    const existing = await files.findLiveFileByPath(client, stored.tenantId, stored.path, {
      forUpdate: true,
    });
    let replaced: FileRecord | null = null;
    if (existing) {
      if (!stored.overwrite) throw new PathConflictError(stored.path);
      replaced = await files.markDeleted(client, stored.tenantId, existing.id, now);
      if (replaced) {
        await tenants.releaseBytes(client, stored.tenantId, replaced.size, this.deps.logger);
      }
    }
    try {
      const file = await files.insertFile(client, {
        id: stored.id,
        tenantId: stored.tenantId,
        path: stored.path,
        size: stored.size,
        sha256: stored.sha256,
        contentType: stored.content.contentType,
        declaredType: stored.declaredType,
        originalName: stored.originalName,
        storageDriver: this.deps.storage.name,
        storageKey: stored.storageKey,
        image: stored.content.image,
        createdAt: now,
      });
      return { file, replaced };
    } catch (err) {
      // Another upload created a file at this path after the lookup above.
      if (isUniqueViolation(err, LIVE_PATH_INDEX)) throw new PathConflictError(stored.path);
      throw err;
    }
  }

  /**
   * Remove the storage object of a file whose row is already soft-deleted and committed, and
   * record that it is gone. A failure is logged and left for the cleanup job, never thrown: the
   * request that deleted the file has succeeded.
   */
  async removeObjectOf(file: FileRecord): Promise<void> {
    try {
      await this.deps.storage.delete(file.storageKey);
      await files.markObjectsDeleted(this.deps.pool, [file.id], this.deps.clock.now());
    } catch (err) {
      this.deps.logger.warn(
        { err, fileId: file.id, storageKey: file.storageKey },
        "could not remove the storage object of a deleted file; the cleanup job will retry",
      );
    }
  }

  /**
   * Remove an object no row refers to (a failed upload's bytes). Failures are logged: the object
   * is unreachable either way.
   */
  async discardObject(storageKey: string): Promise<void> {
    try {
      await this.deps.storage.delete(storageKey);
    } catch (err) {
      this.deps.logger.error({ err, storageKey }, "could not remove the object of a failed upload");
    }
  }
}
