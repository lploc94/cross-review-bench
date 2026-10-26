import { randomUUID } from "node:crypto";
import { Writable, pipeline as pipelineCallback, type Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { Pool } from "../db/pool.js";
import { withTransaction } from "../db/tx.js";
import {
  ChunkInProgressError,
  ConflictError,
  NotFoundError,
  PathConflictError,
  PayloadTooLargeError,
  QuotaExceededError,
  StorageError,
  UploadIncompleteError,
  UploadOffsetMismatchError,
  UploadSessionStateError,
  ValidationError,
} from "../domain/errors.js";
import { normalizePath, originalNameFrom, storageKeyFor } from "../domain/paths.js";
import { normalizeDeclaredType, SNIFF_BYTES } from "../domain/sniff.js";
import {
  effectiveState,
  hasActiveChunk,
  remainingBytes,
  type UploadSession,
} from "../domain/uploadSession.js";
import { addSeconds, type Clock } from "../infra/clock.js";
import type { Logger } from "../infra/logger.js";
import { failAfter, UploadMeter } from "../infra/streams.js";
import * as files from "../repositories/fileRepo.js";
import * as tenants from "../repositories/tenantRepo.js";
import * as sessions from "../repositories/uploadSessionRepo.js";
import { MAX_PART_INDEX, type StorageDriver } from "../storage/driver.js";
import type { FileCatalog } from "./fileCatalog.js";
import type { UploadOutcome } from "./uploadService.js";

export interface ResumableDeps {
  readonly pool: Pool;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly storage: StorageDriver;
  readonly catalog: FileCatalog;
  readonly maxUploadBytes: number;
  readonly sessionTtlSeconds: number;
  readonly chunkLeaseSeconds: number;
}

export interface NewSessionInput {
  readonly tenantId: string;
  readonly path: string;
  readonly size: number;
  readonly contentType?: string;
  readonly overwrite: boolean;
}

export interface ChunkInput {
  readonly tenantId: string;
  readonly sessionId: string;
  /** Where the client says the chunk starts (the Upload-Offset header). */
  readonly offset: number;
  /** The chunk's length when the client announced it. */
  readonly size?: number;
  readonly body: Readable;
}

/** A chunk writer stops this long before its claim lapses, so it never outlives the claim. */
const LEASE_MARGIN_MS = 5_000;

/**
 * Resumable uploads. A session reserves its declared size against the quota, takes chunks that
 * must start exactly at its current offset, and on completion assembles the chunks into a file.
 *
 * Only one chunk is written at a time: a writer claims the session at its offset (a lease stored
 * on the row, so no connection is held while the chunk streams in), stages the chunk as the next
 * part, and commits the new offset only if it still holds the claim.
 */
export class ResumableUploadService {
  private readonly deps: ResumableDeps;

  constructor(deps: ResumableDeps) {
    this.deps = deps;
  }

  async createSession(input: NewSessionInput): Promise<UploadSession> {
    const { pool, clock } = this.deps;
    const path = normalizePath(input.path);
    if (!Number.isSafeInteger(input.size) || input.size < 1) {
      throw new ValidationError("size must be a positive whole number of bytes");
    }
    if (input.size > this.deps.maxUploadBytes) {
      throw new PayloadTooLargeError(this.deps.maxUploadBytes);
    }
    let declaredType: string | null = null;
    if (input.contentType !== undefined) {
      declaredType = normalizeDeclaredType(input.contentType);
      if (declaredType === null) throw new ValidationError("contentType must be a media type");
    }
    if (!input.overwrite && (await files.findLiveFileByPath(pool, input.tenantId, path))) {
      throw new PathConflictError(path);
    }
    const now = clock.now();
    const session = await withTransaction(pool, async (client) => {
      if (!(await tenants.reserveBytes(client, input.tenantId, input.size))) {
        throw new QuotaExceededError(input.size);
      }
      return sessions.insertSession(client, {
        id: randomUUID(),
        tenantId: input.tenantId,
        path,
        size: input.size,
        declaredType,
        originalName: originalNameFrom(undefined, path),
        overwrite: input.overwrite,
        createdAt: now,
        expiresAt: addSeconds(now, this.deps.sessionTtlSeconds),
      });
    });
    this.deps.logger.info(
      { tenantId: input.tenantId, sessionId: session.id, size: session.size },
      "upload session created",
    );
    return session;
  }

  async getSession(tenantId: string, sessionId: string): Promise<UploadSession> {
    const session = await sessions.findSession(this.deps.pool, tenantId, sessionId);
    if (!session) throw NotFoundError.resource("upload session", sessionId);
    return session;
  }

  /** An open session (for HEAD): anything else is reported as its state. */
  async getOpenSession(tenantId: string, sessionId: string): Promise<UploadSession> {
    const session = await this.getSession(tenantId, sessionId);
    const state = effectiveState(session, this.deps.clock.now());
    if (state !== "open") throw new UploadSessionStateError(sessionId, state);
    return session;
  }

  /** Append one chunk; returns the session with its new offset. */
  async appendChunk(input: ChunkInput): Promise<UploadSession> {
    try {
      return await this.append(input);
    } catch (err) {
      input.body.destroy();
      throw err;
    }
  }

  private async append(input: ChunkInput): Promise<UploadSession> {
    const { pool, clock, storage } = this.deps;
    if (!Number.isSafeInteger(input.offset) || input.offset < 0) {
      throw new ValidationError("Upload-Offset must be a non-negative whole number");
    }
    if (input.size === 0) throw new ValidationError("a chunk must not be empty");
    const now = clock.now();
    const token = randomUUID();
    const claimed = await sessions.claimChunk(pool, {
      tenantId: input.tenantId,
      id: input.sessionId,
      offset: input.offset,
      token,
      now,
      leaseExpiresAt: addSeconds(now, this.deps.chunkLeaseSeconds),
    });
    if (!claimed) throw await this.claimFailure(input, now);

    const leaseMs = this.deps.chunkLeaseSeconds * 1000;
    let cancelDeadline = (): void => undefined;
    try {
      if (claimed.partCount >= MAX_PART_INDEX) {
        throw new ValidationError(`an upload takes at most ${MAX_PART_INDEX} chunks; send larger chunks`);
      }
      const remaining = remainingBytes(claimed);
      const tooLarge = () =>
        new PayloadTooLargeError(remaining, `the chunk runs past the declared size; ${remaining} bytes remain`);
      if (input.size !== undefined && input.size > remaining) throw tooLarge();
      const meter = new UploadMeter({ maxBytes: remaining, headBytes: 0, tooLarge });
      const metered = pipelineCallback(input.body, meter, () => undefined);
      cancelDeadline = failAfter(
        meter,
        Math.max(leaseMs - LEASE_MARGIN_MS, leaseMs / 2),
        () => new ConflictError("the chunk took longer than its claim on the upload session"),
      );
      const { bytes } = await storage.stagePart(input.sessionId, claimed.partCount + 1, metered);
      if (bytes === 0) throw new ValidationError("a chunk must not be empty");
      const committed = await sessions.commitChunk(pool, {
        id: input.sessionId,
        token,
        bytes,
        now: clock.now(),
      });
      if (!committed) {
        throw new ConflictError("the upload session changed while the chunk was being written");
      }
      return committed;
    } catch (err) {
      await this.releaseClaim(input.sessionId, token);
      throw err;
    } finally {
      cancelDeadline();
    }
  }

  /** Why a chunk could not claim the session, as the error the client should see. */
  private async claimFailure(input: ChunkInput, now: Date): Promise<Error> {
    const session = await sessions.findSession(this.deps.pool, input.tenantId, input.sessionId);
    if (!session) return NotFoundError.resource("upload session", input.sessionId);
    const state = effectiveState(session, now);
    if (state !== "open") return new UploadSessionStateError(session.id, state);
    if (session.offset !== input.offset) {
      return new UploadOffsetMismatchError(session.offset, input.offset);
    }
    if (hasActiveChunk(session, now)) return new ChunkInProgressError(session.id);
    return new ConflictError("the upload session changed; retry the chunk");
  }

  private async releaseClaim(sessionId: string, token: string): Promise<void> {
    try {
      await sessions.releaseChunk(this.deps.pool, sessionId, token);
    } catch (err) {
      // The claim lapses on its own at its expiry.
      this.deps.logger.error({ err, sessionId }, "could not release a chunk claim");
    }
  }

  /**
   * Assemble the chunks into a file. The bytes are read back once to hash and sniff them; the
   * file row is created and the session closed in one transaction that first re-checks, under a
   * row lock, that the session is still open, complete and unchanged.
   */
  async complete(tenantId: string, sessionId: string): Promise<UploadOutcome> {
    const { pool, clock, storage, catalog } = this.deps;
    const session = await this.getSession(tenantId, sessionId);
    const now = clock.now();
    const state = effectiveState(session, now);
    if (state !== "open") throw new UploadSessionStateError(sessionId, state);
    if (hasActiveChunk(session, now)) throw new ChunkInProgressError(sessionId);
    if (session.offset !== session.size) {
      throw new UploadIncompleteError(sessionId, session.offset, session.size);
    }
    if (!session.overwrite && (await files.findLiveFileByPath(pool, tenantId, session.path))) {
      throw new PathConflictError(session.path);
    }

    const fileId = randomUUID();
    const storageKey = storageKeyFor(tenantId, fileId);
    let committed = false;
    try {
      const { bytes } = await storage.assemble(sessionId, storageKey, session.partCount);
      if (bytes !== session.size) {
        throw new StorageError(`assembled ${bytes} bytes, expected ${session.size}`, {
          storageCode: "SizeMismatch",
        });
      }
      const meter = new UploadMeter({
        maxBytes: session.size,
        headBytes: SNIFF_BYTES,
        tooLarge: () => new StorageError("the assembled object grew", { storageCode: "SizeMismatch" }),
      });
      await pipeline(await storage.get(storageKey), meter, discardingSink());
      const content = await catalog.inspect(storageKey, meter.head, bytes);

      const registered = await withTransaction(pool, async (client) => {
        const locked = await sessions.findSession(client, tenantId, sessionId, { forUpdate: true });
        const lockedAt = clock.now();
        if (!locked) throw NotFoundError.resource("upload session", sessionId);
        const lockedState = effectiveState(locked, lockedAt);
        if (lockedState !== "open") throw new UploadSessionStateError(sessionId, lockedState);
        if (
          locked.offset !== locked.size ||
          locked.partCount !== session.partCount ||
          hasActiveChunk(locked, lockedAt)
        ) {
          throw new ConflictError("the upload session changed while it was being completed");
        }
        const result = await catalog.register(client, {
          id: fileId,
          tenantId,
          path: locked.path,
          overwrite: locked.overwrite,
          size: bytes,
          sha256: meter.sha256,
          declaredType: locked.declaredType,
          originalName: locked.originalName,
          storageKey,
          content,
        });
        // The session's reservation becomes the file's bytes: nothing to reserve or release.
        await sessions.closeSession(client, { id: sessionId, state: "completed", fileId, now: lockedAt });
        return result;
      });
      committed = true;
      await this.discardStaging(sessionId);
      if (registered.replaced) await catalog.removeObjectOf(registered.replaced);
      this.deps.logger.info({ tenantId, sessionId, fileId, bytes }, "resumable upload completed");
      return { file: registered.file, replaced: registered.replaced !== null };
    } finally {
      if (!committed) await catalog.discardObject(storageKey);
    }
  }

  /** Abort an open session: release its reservation and drop its staged chunks. */
  async abort(tenantId: string, sessionId: string): Promise<void> {
    const { pool, clock, logger } = this.deps;
    await withTransaction(pool, async (client) => {
      const session = await sessions.findSession(client, tenantId, sessionId, { forUpdate: true });
      if (!session) throw NotFoundError.resource("upload session", sessionId);
      const now = clock.now();
      const state = effectiveState(session, now);
      if (state !== "open") throw new UploadSessionStateError(sessionId, state);
      await sessions.closeSession(client, { id: sessionId, state: "aborted", now });
      await tenants.releaseBytes(client, tenantId, session.size, logger);
    });
    await this.discardStaging(sessionId);
    logger.info({ tenantId, sessionId }, "upload session aborted");
  }

  /** Drop staged chunks; on failure the cleanup job removes them as orphans later. */
  private async discardStaging(sessionId: string): Promise<void> {
    try {
      await this.deps.storage.discardStaging(sessionId);
    } catch (err) {
      this.deps.logger.warn({ err, sessionId }, "could not discard staged chunks");
    }
  }
}

/** A sink that accepts and drops everything, to run a stream through a meter. */
function discardingSink(): Writable {
  return new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
}
