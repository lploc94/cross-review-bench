import { loadScriptConfig } from "../config/env.js";
import { createPool, type Pool } from "../db/pool.js";
import { createLogger, type Logger } from "../infra/logger.js";

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

/**
 * Run an administration script with a database pool: usage errors print the usage text and exit
 * 2, other failures exit 1. The pool is always closed.
 */
export async function runScript(
  usage: string,
  body: (context: { pool: Pool; logger: Logger }) => Promise<void>,
): Promise<void> {
  let pool: Pool | undefined;
  try {
    const config = loadScriptConfig();
    const logger = createLogger({ level: config.logLevel, name: "uploads-admin" });
    pool = createPool({ connectionString: config.databaseUrl, max: 2, logger });
    await body({ pool, logger });
  } catch (err) {
    if (err instanceof UsageError) {
      process.stderr.write(`${err.message}\n\n${usage}\n`);
      process.exitCode = 2;
    } else {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exitCode = 1;
    }
  } finally {
    await pool?.end();
  }
}
