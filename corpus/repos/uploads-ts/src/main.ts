import { buildApp, createCleanupService, createScanner, createScanWorker } from "./app.js";
import { ConfigError, loadConfig, type Config } from "./config/env.js";
import { createPool } from "./db/pool.js";
import { systemClock } from "./infra/clock.js";
import { createLogger } from "./infra/logger.js";
import { PeriodicTask } from "./infra/loop.js";
import { ScanWorker } from "./services/scanWorker.js";
import { createStorageDriver } from "./storage/factory.js";

function readConfig(): Config {
  try {
    return loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      process.stderr.write(`${err.message}\n`);
      process.exit(1);
    }
    throw err;
  }
}

async function main(): Promise<void> {
  const config = readConfig();
  const logger = createLogger({ level: config.logLevel });
  const pool = createPool({
    connectionString: config.databaseUrl,
    max: config.databasePoolMax,
    logger,
  });
  const storage = await createStorageDriver(config.storage, systemClock);
  const scanner = createScanner(config.scanner, logger);
  const deps = { pool, clock: systemClock, logger, storage, scanner, config };

  const app = await buildApp(deps);
  const scanWorker = createScanWorker(deps);
  const cleanup = createCleanupService(deps);
  const scanLoop = new PeriodicTask({
    name: "scan",
    intervalMs: config.scan.pollIntervalMs,
    logger,
    run: async () => ScanWorker.hasMore(await scanWorker.runOnce(), config.scan.batchSize),
  });
  const cleanupLoop = new PeriodicTask({
    name: "cleanup",
    intervalMs: config.cleanup.intervalSeconds * 1000,
    logger,
    run: async () => {
      await cleanup.runOnce();
      return false;
    },
  });

  let shuttingDown = false;
  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, "shutting down");
    const deadline = setTimeout(() => {
      logger.error("graceful shutdown timed out, exiting");
      process.exit(1);
    }, config.shutdownTimeoutMs);
    deadline.unref();
    try {
      // Stop the background loops (each finishes its current run), stop taking requests and
      // let in-flight ones finish, and only then close the database connections they all use.
      await Promise.all([scanLoop.stop(), cleanupLoop.stop()]);
      await app.close();
      await pool.end();
      logger.info("shutdown complete");
      process.exit(0);
    } catch (err) {
      logger.error({ err }, "shutdown failed");
      process.exit(1);
    }
  };
  process.on("SIGTERM", (signal) => void shutdown(signal));
  process.on("SIGINT", (signal) => void shutdown(signal));

  await app.listen({ host: config.host, port: config.port });
  scanLoop.start();
  cleanupLoop.start();
}

main().catch((err: unknown) => {
  process.stderr.write(`fatal: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exit(1);
});
