import type { Pool, PoolClient } from "./pool.js";

export type IsolationLevel = "read committed" | "repeatable read" | "serializable";

const BEGIN_STATEMENTS: Record<IsolationLevel, string> = {
  "read committed": "BEGIN ISOLATION LEVEL READ COMMITTED",
  "repeatable read": "BEGIN ISOLATION LEVEL REPEATABLE READ",
  serializable: "BEGIN ISOLATION LEVEL SERIALIZABLE",
};

/**
 * Run `fn` inside a transaction on a dedicated client: COMMIT when it resolves, ROLLBACK when it
 * throws (the original error is rethrown). The client always goes back to the pool; one whose
 * BEGIN, COMMIT or ROLLBACK failed is destroyed instead of being reused in an unknown state.
 */
export async function withTransaction<T>(
  pool: Pool,
  fn: (client: PoolClient) => Promise<T>,
  options: { isolation?: IsolationLevel } = {},
): Promise<T> {
  const client = await pool.connect();
  let broken: Error | undefined;
  try {
    try {
      await client.query(options.isolation ? BEGIN_STATEMENTS[options.isolation] : "BEGIN");
    } catch (err) {
      broken = asError(err);
      throw err;
    }
    let result: T;
    try {
      result = await fn(client);
    } catch (err) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {
        broken = asError(rollbackError);
      }
      throw err;
    }
    try {
      await client.query("COMMIT");
    } catch (err) {
      // The outcome of a COMMIT that failed in flight is unknown; never reuse the connection.
      broken = asError(err);
      throw err;
    }
    return result;
  } finally {
    client.release(broken);
  }
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
