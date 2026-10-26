import pg from "pg";
import { runMigrations } from "../../src/db/migrate.js";
import { testDatabaseUrl } from "./env.js";

/** Bring the test database to the current schema once per test run. */
export default async function setup(): Promise<void> {
  const pool = new pg.Pool({ connectionString: testDatabaseUrl(), max: 1 });
  try {
    await runMigrations(pool);
  } finally {
    await pool.end();
  }
}
