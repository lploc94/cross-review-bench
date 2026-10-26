import type { Readable } from "node:stream";
import type { Pool } from "../db/pool.js";
import { withTransaction } from "../db/tx.js";
import { decodeCursor, toCursorPage, type CursorPage } from "../domain/cursor.js";
import {
  FileNotAvailableError,
  InvalidSignatureError,
  NotFoundError,
  SignedUrlExpiredError,
  ValidationError,
} from "../domain/errors.js";
import { isDownloadable, type FileRecord } from "../domain/file.js";
import { normalizePath } from "../domain/paths.js";
import type { Clock } from "../infra/clock.js";
import type { Logger } from "../infra/logger.js";
import * as files from "../repositories/fileRepo.js";
import * as tenants from "../repositories/tenantRepo.js";
import type { StorageDriver } from "../storage/driver.js";
import type { FileCatalog } from "./fileCatalog.js";
import { downloadPayload, unixNow, type UrlSigner } from "./urlSigner.js";

export interface FileServiceDeps {
  readonly pool: Pool;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly storage: StorageDriver;
  readonly catalog: FileCatalog;
  readonly signer: UrlSigner;
  readonly signedUrlMaxTtlSeconds: number;
  readonly listMaxLimit: number;
}

export interface SignedUrl {
  /** Path and query of the public download route; prefix it with the service's base URL. */
  readonly url: string;
  readonly expiresAt: Date;
}

/** Reading, listing and deleting stored files, and signed download links. */
export class FileService {
  private readonly deps: FileServiceDeps;

  constructor(deps: FileServiceDeps) {
    this.deps = deps;
  }

  async getById(tenantId: string, id: string): Promise<FileRecord> {
    const file = await files.findLiveFileById(this.deps.pool, tenantId, id);
    if (!file) throw NotFoundError.resource("file", id);
    return file;
  }

  async getByPath(tenantId: string, rawPath: string): Promise<FileRecord> {
    const path = normalizePath(rawPath);
    const file = await files.findLiveFileByPath(this.deps.pool, tenantId, path);
    if (!file) throw new NotFoundError(`no file at ${path}`, { path });
    return file;
  }

  /** One page of the tenant's live files in path order. */
  async list(
    tenantId: string,
    options: { after?: string; limit: number },
  ): Promise<CursorPage<FileRecord>> {
    if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > this.deps.listMaxLimit) {
      throw new ValidationError(`limit must be from 1 to ${this.deps.listMaxLimit}`);
    }
    const after = options.after === undefined ? null : decodeCursor(options.after);
    const rows = await files.listLiveFiles(this.deps.pool, tenantId, after, options.limit + 1);
    return toCursorPage(rows, options.limit);
  }

  /**
   * Soft-delete the file at a path and release its bytes, then remove its storage object once
   * the deletion is committed. If the object cannot be removed now, the cleanup job will.
   */
  async deleteByPath(tenantId: string, rawPath: string): Promise<FileRecord> {
    const path = normalizePath(rawPath);
    const deleted = await withTransaction(this.deps.pool, async (client) => {
      const file = await files.findLiveFileByPath(client, tenantId, path, { forUpdate: true });
      if (!file) throw new NotFoundError(`no file at ${path}`, { path });
      const row = await files.markDeleted(client, tenantId, file.id, this.deps.clock.now());
      if (!row) throw new NotFoundError(`no file at ${path}`, { path });
      await tenants.releaseBytes(client, tenantId, row.size, this.deps.logger);
      return row;
    });
    await this.deps.catalog.removeObjectOf(deleted);
    this.deps.logger.info({ tenantId, fileId: deleted.id, bytes: deleted.size }, "file deleted");
    return deleted;
  }

  /** The file's bytes, for a download. Only available (scanned, clean) files are served. */
  async openContent(file: FileRecord): Promise<Readable> {
    this.assertDownloadable(file);
    return this.deps.storage.get(file.storageKey);
  }

  assertDownloadable(file: FileRecord): void {
    if (!isDownloadable(file)) throw new FileNotAvailableError(file.id, file.status);
  }

  /** A download link for one of the tenant's files, valid for `expiresIn` seconds. */
  async createSignedUrl(tenantId: string, id: string, expiresIn: number): Promise<SignedUrl> {
    const max = this.deps.signedUrlMaxTtlSeconds;
    if (!Number.isInteger(expiresIn) || expiresIn < 1 || expiresIn > max) {
      throw new ValidationError(`expiresIn must be a whole number of seconds from 1 to ${max}`);
    }
    const file = await this.getById(tenantId, id);
    const exp = unixNow(this.deps.clock) + expiresIn;
    const sig = this.deps.signer.sign(downloadPayload(file.id, exp));
    return { url: `/v1/public/${file.id}?exp=${exp}&sig=${sig}`, expiresAt: new Date(exp * 1000) };
  }

  /**
   * The file a signed link points at. The signature is checked before the expiry, so a forged
   * link learns nothing; then the file must still exist.
   */
  async resolveSignedDownload(id: string, exp: string, sig: string): Promise<FileRecord> {
    if (!/^[1-9]\d{0,11}$/.test(exp) || !this.deps.signer.verify(downloadPayload(id, Number(exp)), sig)) {
      throw new InvalidSignatureError();
    }
    const expiresAt = Number(exp);
    if (expiresAt <= unixNow(this.deps.clock)) {
      throw new SignedUrlExpiredError(new Date(expiresAt * 1000));
    }
    const file = await files.findLiveFileBySignedId(this.deps.pool, id);
    if (!file) throw NotFoundError.resource("file", id);
    return file;
  }
}
