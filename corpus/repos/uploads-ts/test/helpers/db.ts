import pg from "pg";
import type { Pool } from "../../src/db/pool.js";
import { testDatabaseUrl } from "./env.js";

// Migration bookkeeping survives between tests; every other table is emptied.
const KEPT_TABLES = new Set(["schema_migrations"]);

let pool: Pool | null = null;

/** The test file's pool, created on first use and closed after the file's tests. */
export function testPool(): Pool {
  pool ??= new pg.Pool({ connectionString: testDatabaseUrl(), max: 10 });
  return pool;
}

/** Empty every data table, so each test starts without tenants, files or sessions. */
export async function resetState(): Promise<void> {
  const db = testPool();
  const result = await db.query<{ tablename: string }>(
    "SELECT tablename FROM pg_tables WHERE schemaname = current_schema()",
  );
  const tables = result.rows.map((row) => row.tablename).filter((name) => !KEPT_TABLES.has(name));
  if (tables.length > 0) {
    await db.query(`TRUNCATE TABLE ${tables.map((t) => `"${t}"`).join(", ")} RESTART IDENTITY CASCADE`);
  }
}

export async function closeConnections(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
