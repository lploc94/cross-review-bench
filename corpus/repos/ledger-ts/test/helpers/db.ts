import { Redis } from "ioredis";
import pg from "pg";
import type { Pool } from "../../src/db/pool.js";
import { testDatabaseUrl, testRedisUrl } from "./env.js";

// Tables that hold reference data or migration bookkeeping and survive between tests.
const KEPT_TABLES = new Set(["currencies", "schema_migrations"]);

let pool: Pool | null = null;
let redis: Redis | null = null;

/** The test file's pool, created on first use and closed after the file's tests. */
export function testPool(): Pool {
  pool ??= new pg.Pool({ connectionString: testDatabaseUrl(), max: 10 });
  return pool;
}

export function testRedis(): Redis {
  redis ??= new Redis(testRedisUrl(), { maxRetriesPerRequest: 2 });
  return redis;
}

/** Empty every data table and the Redis db, so each test starts from a blank ledger. */
export async function resetState(): Promise<void> {
  const db = testPool();
  const result = await db.query<{ tablename: string }>(
    "SELECT tablename FROM pg_tables WHERE schemaname = current_schema()",
  );
  const tables = result.rows.map((row) => row.tablename).filter((name) => !KEPT_TABLES.has(name));
  if (tables.length > 0) {
    await db.query(`TRUNCATE TABLE ${tables.map((t) => `"${t}"`).join(", ")} RESTART IDENTITY CASCADE`);
  }
  await testRedis().flushdb();
}

export async function closeConnections(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
  if (redis) {
    await redis.quit();
    redis = null;
  }
}
