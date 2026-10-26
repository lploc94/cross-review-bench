import type { Pool } from "../db/pool.js";
import type { FileRecord } from "../domain/file.js";
import { addSeconds, type Clock } from "../infra/clock.js";
import type { Logger } from "../infra/logger.js";
import * as files from "../repositories/fileRepo.js";
import type { StorageDriver } from "../storage/driver.js";
import type { Scanner, ScanVerdict } from "./scanner.js";

export interface ScanSettings {
  readonly maxAttempts: number;
  readonly backoffBaseSeconds: number;
  readonly backoffMaxSeconds: number;
  readonly batchSize: number;
  readonly claimLeaseSeconds: number;
}

export interface ScanWorkerDeps {
  readonly pool: Pool;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly storage: StorageDriver;
  readonly scanner: Scanner;
  readonly settings: ScanSettings;
}

export interface ScanBatchReport {
  readonly claimed: number;
  readonly available: number;
  readonly quarantined: number;
  readonly retried: number;
}

/**
 * Delay before scan attempt `failures + 1`: the base doubled per failure so far, capped.
 */
export function scanBackoffSeconds(failures: number, settings: ScanSettings): number {
  const exponent = Math.min(Math.max(failures - 1, 0), 30);
  return Math.min(settings.backoffBaseSeconds * 2 ** exponent, settings.backoffMaxSeconds);
}

/**
 * Moves new files out of `pending_scan`: claims a batch of files whose scan is due, scans each,
 * and records `available` (clean) or `quarantined` (infected). A scan that errors is retried with
 * exponential backoff; after `maxAttempts` failed attempts the file is quarantined.
 */
export class ScanWorker {
  private readonly deps: ScanWorkerDeps;

  constructor(deps: ScanWorkerDeps) {
    this.deps = deps;
  }

  async runOnce(): Promise<ScanBatchReport> {
    const { pool, clock, settings } = this.deps;
    const now = clock.now();
    const claimed = await files.claimFilesForScan(
      pool,
      now,
      addSeconds(now, settings.claimLeaseSeconds),
      settings.batchSize,
    );
    const report = { claimed: claimed.length, available: 0, quarantined: 0, retried: 0 };
    for (const file of claimed) {
      const outcome = await this.scanFile(file);
      if (outcome !== null) report[outcome]++;
    }
    return report;
  }

  /** Whether the last run filled its batch, i.e. more files may be waiting. */
  static hasMore(report: ScanBatchReport, batchSize: number): boolean {
    return report.claimed >= batchSize;
  }

  private async verdictFor(file: FileRecord): Promise<ScanVerdict> {
    let stream;
    try {
      stream = await this.deps.storage.get(file.storageKey);
    } catch (err) {
      this.deps.logger.warn({ err, fileId: file.id }, "could not read a file to scan it");
      return "error";
    }
    try {
      return await this.deps.scanner.scan(stream);
    } catch (err) {
      this.deps.logger.warn({ err, fileId: file.id }, "scanner failed");
      return "error";
    } finally {
      stream.destroy();
    }
  }

  /** Scan one file and record the outcome; null when the file left `pending_scan` meanwhile. */
  private async scanFile(
    file: FileRecord,
  ): Promise<"available" | "quarantined" | "retried" | null> {
    const { pool, clock, logger, settings } = this.deps;
    const verdict = await this.verdictFor(file);
    const now = clock.now();
    switch (verdict) {
      case "clean":
        return (await files.recordScanVerdict(pool, file.id, "available", now)) ? "available" : null;
      case "infected": {
        const recorded = await files.recordScanVerdict(pool, file.id, "quarantined", now);
        if (recorded) logger.warn({ fileId: file.id, tenantId: file.tenantId }, "file quarantined: infected");
        return recorded ? "quarantined" : null;
      }
      case "error": {
        const failures = file.scanAttempts + 1;
        if (failures >= settings.maxAttempts) {
          const recorded = await files.quarantineAfterFailures(pool, file.id, now);
          if (recorded) {
            logger.warn({ fileId: file.id, failures }, "file quarantined: it could not be scanned");
          }
          return recorded ? "quarantined" : null;
        }
        const next = addSeconds(now, scanBackoffSeconds(failures, settings));
        return (await files.recordScanFailure(pool, file.id, next, now)) ? "retried" : null;
      }
    }
  }
}
