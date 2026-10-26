import { systemClock } from "@sync/shared";
import { buildApp } from "./app.js";
import { ConfigError, loadConfig, type Config } from "./config/env.js";
import { createPool } from "./db/pool.js";
import { createLogger } from "./infra/logger.js";

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
  const pool = createPool({ connectionString: config.databaseUrl, max: config.databasePoolMax, logger });
  const app = await buildApp({ pool, clock: systemClock, logger, config });

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
      // Stop taking requests and let in-flight ones finish before closing their connections.
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
}

main().catch((err: unknown) => {
  process.stderr.write(`fatal: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exit(1);
});
