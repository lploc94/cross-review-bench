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
    const logger = createLogger({ level: config.logLevel, name: "sync-admin" });
    pool = createPool({ connectionString: config.databaseUrl, max: 2, logger, applicationName: "sync-admin" });
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

/** `--name value` options after a command; every option takes a value and may appear once. */
export function parseOptions(args: readonly string[], allowed: readonly string[]): Map<string, string> {
  const options = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i] ?? "";
    const value = args[i + 1];
    if (!flag.startsWith("--") || !allowed.includes(flag.slice(2))) {
      throw new UsageError(`unknown option ${flag}`);
    }
    if (value === undefined || value.startsWith("--")) throw new UsageError(`${flag} needs a value`);
    if (options.has(flag.slice(2))) throw new UsageError(`${flag} given twice`);
    options.set(flag.slice(2), value);
  }
  return options;
}

export function requireOption(options: Map<string, string>, name: string): string {
  const value = options.get(name);
  if (value === undefined) throw new UsageError(`--${name} is required`);
  return value;
}
