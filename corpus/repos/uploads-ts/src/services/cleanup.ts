import type { Pool } from "../db/pool.js";
import { withTransaction } from "../db/tx.js";
import { addSeconds, type Clock } from "../infra/clock.js";
import type { Logger } from "../infra/logger.js";
import * as files from "../repositories/fileRepo.js";
import * as tenants from "../repositories/tenantRepo.js";
import * as sessions from "../repositories/uploadSessionRepo.js";
import type { StorageDriver } from "../storage/driver.js";

export interface CleanupSettings {
  readonly batchSize: number;
  readonly deletedGraceSeconds: number;
}

export interface CleanupDeps {
  readonly pool: Pool;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly storage: StorageDriver;
  readonly settings: CleanupSettings;
}

export interface CleanupReport {
  readonly expiredSessions: number;
  readonly purgedObjects: number;
  readonly orphanedStaging: number;
}

/** A run stops after this many batches per step, so one run never goes on indefinitely. */
export const MAX_BATCHES_PER_RUN = 50;

/**
 * Periodic housekeeping, safe to run from several processes at once:
 *
 * 1. expire open upload sessions past their expiry, releasing their reservations and dropping
 *    their staged chunks;
 * 2. remove the storage objects of soft-deleted files once their grace period is over (normally
 *    removed right after the delete; this catches the ones that failed then);
 * 3. remove staged chunks that belong to no open session.
 *
 * Steps 1 and 2 lock their rows with FOR UPDATE SKIP LOCKED, so concurrent runs split the work.
 * A failing step is logged and does not stop the others.
 */
export class CleanupService {
  private readonly deps: CleanupDeps;

  constructor(deps: CleanupDeps) {
    this.deps = deps;
  }

  async runOnce(): Promise<CleanupReport> {
    const expiredSessions = await this.step("expire upload sessions", () => this.expireSessions());
    const purgedObjects = await this.step("purge deleted objects", () => this.purgeDeletedObjects());
    const orphanedStaging = await this.step("remove orphaned staging", () =>
      this.removeOrphanedStaging(),
    );
    const report = { expiredSessions, purgedObjects, orphanedStaging };
    if (expiredSessions + purgedObjects + orphanedStaging > 0) {
      this.deps.logger.info(report, "cleanup run finished");
    }
    return report;
  }

  private async step(name: string, run: () => Promise<number>): Promise<number> {
    try {
      return await run();
    } catch (err) {
      this.deps.logger.error({ err, step: name }, "cleanup step failed");
      return 0;
    }
  }

  async expireSessions(): Promise<number> {
    const { pool, clock, logger, settings } = this.deps;
    let total = 0;
    for (let batch = 0; batch < MAX_BATCHES_PER_RUN; batch++) {
      const now = clock.now();
      const expired = await withTransaction(pool, async (client) => {
        const due = await sessions.lockExpiredSessions(client, now, settings.batchSize);
        for (const session of due) {
          await sessions.closeSession(client, { id: session.id, state: "expired", now });
          await tenants.releaseBytes(client, session.tenantId, session.size, logger);
        }
        return due;
      });
      for (const session of expired) {
        await this.discardStaging(session.id);
      }
      total += expired.length;
      if (expired.length < settings.batchSize) break;
    }
    return total;
  }

  async purgeDeletedObjects(): Promise<number> {
    const { pool, clock, logger, storage, settings } = this.deps;
    let total = 0;
    for (let batch = 0; batch < MAX_BATCHES_PER_RUN; batch++) {
      const now = clock.now();
      const { locked, removed } = await withTransaction(pool, async (client) => {
        const due = await files.lockDeletedFilesWithObjects(
          client,
          addSeconds(now, -settings.deletedGraceSeconds),
          settings.batchSize,
        );
        const gone: string[] = [];
        for (const file of due) {
          try {
            await storage.delete(file.storageKey);
            gone.push(file.id);
          } catch (err) {
            logger.warn({ err, fileId: file.id }, "could not remove a deleted file's object");
          }
        }
        await files.markObjectsDeleted(client, gone, now);
        return { locked: due.length, removed: gone.length };
      });
      total += removed;
      // Stop on a short batch, or when nothing in a full one could be removed (storage is down).
      if (locked < settings.batchSize || removed === 0) break;
    }
    return total;
  }

  /**
   * Staged chunks whose session is not open. The staging area is listed before the sessions are
   * read, and sessions are created before their first chunk is staged, so a session created
   * meanwhile is never mistaken for an orphan. Rows are read without SKIP LOCKED on purpose: a
   * session being completed holds its row lock and must still count as open.
   */
  async removeOrphanedStaging(): Promise<number> {
    const { pool, storage, settings } = this.deps;
    const staged = (await storage.listStaging()).slice(0, settings.batchSize * MAX_BATCHES_PER_RUN);
    let removed = 0;
    for (let start = 0; start < staged.length; start += settings.batchSize) {
      const batch = staged.slice(start, start + settings.batchSize);
      const open = await sessions.findOpenSessionIds(pool, batch);
      for (const sessionId of batch) {
        if (open.has(sessionId)) continue;
        if (await this.discardStaging(sessionId)) removed++;
      }
    }
    return removed;
  }

  private async discardStaging(sessionId: string): Promise<boolean> {
    try {
      await this.deps.storage.discardStaging(sessionId);
      return true;
    } catch (err) {
      this.deps.logger.warn({ err, sessionId }, "could not discard staged chunks");
      return false;
    }
  }
}
