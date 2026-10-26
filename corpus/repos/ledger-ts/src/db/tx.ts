import type { Pool, PoolClient } from "./pool.js";

export type IsolationLevel = "read committed" | "repeatable read" | "serializable";

export interface TransactionOptions {
  readonly isolation?: IsolationLevel;
}

const BEGIN_STATEMENTS: Record<IsolationLevel, string> = {
  "read committed": "BEGIN ISOLATION LEVEL READ COMMITTED",
  "repeatable read": "BEGIN ISOLATION LEVEL REPEATABLE READ",
  serializable: "BEGIN ISOLATION LEVEL SERIALIZABLE",
};

/**
 * Run `fn` inside a transaction on a dedicated client: COMMIT when it resolves, ROLLBACK when it
 * throws (the original error is rethrown). The client always goes back to the pool; one whose
 * BEGIN or ROLLBACK failed is destroyed instead of being reused in an unknown state.
 */
export async function withTransaction<T>(
  pool: Pool,
  fn: (client: PoolClient) => Promise<T>,
  options: TransactionOptions = {},
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
    try {
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (err) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {
        broken = asError(rollbackError);
      }
      throw err;
    }
  } finally {
    client.release(broken);
  }
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
