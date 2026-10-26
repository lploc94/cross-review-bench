import pg from "pg";
import type { Logger } from "../infra/logger.js";

export type Pool = pg.Pool;
export type PoolClient = pg.PoolClient;

/** Anything that runs a query: the pool for single statements, a client inside a transaction. */
export type Queryable = Pick<pg.Pool | pg.PoolClient, "query">;

/**
 * Column types are left as node-postgres parses them: int8 (event sequence numbers) arrives as a
 * string and the repositories convert it to a safe integer; timestamptz arrives as a Date; jsonb
 * arrives parsed.
 */
export function createPool(options: {
  connectionString: string;
  max: number;
  logger: Logger;
  applicationName?: string;
}): Pool {
  const pool = new pg.Pool({
    connectionString: options.connectionString,
    max: options.max,
    application_name: options.applicationName ?? "sync-server",
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  });
  // An idle client that loses its connection emits here; without a listener it would crash the
  // process. The pool discards the client on its own.
  pool.on("error", (err) => {
    options.logger.error({ err }, "idle postgres client error");
  });
  return pool;
}
