import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { buildApp, createCleanupService, createScanWorker, type AppDeps } from "../../src/app.js";
import { loadConfig, type Config } from "../../src/config/env.js";
import type { Pool } from "../../src/db/pool.js";
import { createLogger } from "../../src/infra/logger.js";
import type { CleanupService } from "../../src/services/cleanup.js";
import type { ScanWorker } from "../../src/services/scanWorker.js";
import type { StorageDriver } from "../../src/storage/driver.js";
import { LocalStorageDriver } from "../../src/storage/localDriver.js";
import { ManualClock } from "./clock.js";
import { testPool } from "./db.js";
import { testDatabaseUrl } from "./env.js";
import { FakeScanner } from "./fakeScanner.js";

export const TEST_SIGNING_SECRET = "test-signing-secret-0123456789abcdef";

export interface TestApp {
  readonly app: FastifyInstance;
  readonly clock: ManualClock;
  readonly pool: Pool;
  readonly config: Config;
  readonly storage: StorageDriver;
  readonly scanner: FakeScanner;
  readonly scanWorker: ScanWorker;
  readonly cleanup: CleanupService;
  /** The local driver's root directory, when the default storage is used. */
  readonly storageRoot: string | null;
  close(): Promise<void>;
}

export interface TestAppOverrides {
  /** Environment overrides on top of the test defaults, e.g. { MAX_UPLOAD_BYTES: "100" }. */
  readonly env?: Record<string, string>;
  readonly clock?: ManualClock;
  /** Another storage driver; by default a local driver in a fresh temporary directory. */
  readonly storage?: StorageDriver;
  readonly scanner?: FakeScanner;
}

export function testConfig(env: Record<string, string> = {}): Config {
  return loadConfig({
    NODE_ENV: "test",
    LOG_LEVEL: process.env.TEST_LOG_LEVEL ?? "silent",
    DATABASE_URL: testDatabaseUrl(),
    SIGNING_SECRET: TEST_SIGNING_SECRET,
    MAX_UPLOAD_BYTES: String(1024 * 1024),
    ...env,
  });
}

/** A local storage driver in a new temporary directory, and the function that removes it. */
export async function temporaryLocalStorage(): Promise<{
  driver: LocalStorageDriver;
  root: string;
  remove: () => Promise<void>;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), "uploads-test-"));
  const driver = new LocalStorageDriver({ root });
  await driver.init();
  return { driver, root, remove: () => rm(root, { recursive: true, force: true }) };
}

/**
 * The real application wired to the test database, a manual clock, a fake scanner, and (unless
 * overridden) a local storage driver in its own temporary directory, removed by `close()`.
 */
export async function buildTestApp(overrides: TestAppOverrides = {}): Promise<TestApp> {
  const config = testConfig(overrides.env);
  const clock = overrides.clock ?? new ManualClock();
  const scanner = overrides.scanner ?? new FakeScanner();
  const local = overrides.storage ? null : await temporaryLocalStorage();
  const storage = overrides.storage ?? local?.driver;
  if (!storage) throw new Error("no storage driver");
  const logger = createLogger({ level: config.logLevel });
  const pool = testPool();
  const deps: AppDeps = { pool, clock, logger, storage, scanner, config };
  const app = await buildApp(deps);
  await app.ready();
  return {
    app,
    clock,
    pool,
    config,
    storage,
    scanner,
    scanWorker: createScanWorker(deps),
    cleanup: createCleanupService(deps),
    storageRoot: local?.root ?? null,
    close: async () => {
      // A test's requests are over by now; a keep-alive connection whose response finished just
      // as the server began closing would otherwise hold close() until its keep-alive timeout.
      app.server.closeAllConnections();
      await app.close();
      await local?.remove();
    },
  };
}
