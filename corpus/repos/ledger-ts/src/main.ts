import { buildApp, createOutboxDispatcher } from "./app.js";
import { ConfigError, loadConfig, type Config } from "./config/env.js";
import { createPool } from "./db/pool.js";
import { systemClock } from "./infra/clock.js";
import { HttpWebhookSender } from "./infra/httpWebhookSender.js";
import { createLogger } from "./infra/logger.js";
import { closeRedis, createRedis } from "./infra/redis.js";

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
  const redis = createRedis(config.redisUrl, logger);
  const sender = new HttpWebhookSender({ timeoutMs: config.webhookTimeoutMs });
  const deps = { pool, redis, clock: systemClock, logger, sender, config };

  const app = await buildApp(deps);
  const dispatcher = createOutboxDispatcher(deps);

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
      // Stop taking requests and let in-flight ones finish, then let the dispatcher finish
      // its batch, and only then close the connections both of them use.
      await app.close();
      await dispatcher.stop();
      await pool.end();
      await closeRedis(redis);
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
  dispatcher.start();
}

main().catch((err: unknown) => {
  process.stderr.write(`fatal: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exit(1);
});
