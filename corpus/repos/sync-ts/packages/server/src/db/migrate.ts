import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Logger } from "../infra/logger.js";
import type { Pool, PoolClient } from "./pool.js";

/** `packages/server/migrations/`, from both `src/db` and the compiled `dist/db`. */
export const MIGRATIONS_DIR = fileURLToPath(new URL("../../migrations/", import.meta.url));

// Arbitrary but fixed: every process migrating one database takes this session-level lock.
const ADVISORY_LOCK_KEY = "4812093317";
const FILE_PATTERN = /^(\d{4})_([a-z0-9_]+)\.sql$/;

export interface Migration {
  readonly version: string;
  readonly name: string;
  readonly sql: string;
  readonly checksum: string;
}

export class MigrationError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "MigrationError";
  }
}

/** Read `NNNN_name.sql` files in version order. Other files in the folder are ignored. */
export async function loadMigrations(directory: string = MIGRATIONS_DIR): Promise<Migration[]> {
  const files = (await readdir(directory)).filter((file) => FILE_PATTERN.test(file)).sort();
  const migrations: Migration[] = [];
  for (const file of files) {
    const match = FILE_PATTERN.exec(file);
    if (!match?.[1] || !match[2]) continue;
    const version = match[1];
    if (migrations.some((m) => m.version === version)) {
      throw new MigrationError(`two migrations share version ${version}`);
    }
    const sql = await readFile(path.join(directory, file), "utf8");
    migrations.push({
      version,
      name: match[2],
      sql,
      checksum: createHash("sha256").update(sql).digest("hex"),
    });
  }
  return migrations;
}

interface AppliedRow {
  version: string;
  checksum: string;
}

/**
 * Apply every migration not yet recorded in `schema_migrations`, each in its own transaction.
 * A session-level advisory lock serializes concurrent runners (several instances starting at
 * once). A recorded migration whose file changed or disappeared stops the run: the database
 * would no longer match the code. Returns the names of the migrations applied.
 */
export async function runMigrations(
  pool: Pool,
  options: { directory?: string; logger?: Logger } = {},
): Promise<string[]> {
  const migrations = await loadMigrations(options.directory);
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock($1::bigint)", [ADVISORY_LOCK_KEY]);
    try {
      await ensureMigrationsTable(client);
      const applied = await appliedMigrations(client);
      verifyApplied(migrations, applied);
      const pending = migrations.filter((m) => !applied.has(m.version));
      for (const migration of pending) {
        await applyMigration(client, migration);
        options.logger?.info({ version: migration.version, name: migration.name }, "migration applied");
      }
      return pending.map((m) => `${m.version}_${m.name}`);
    } finally {
      await client.query("SELECT pg_advisory_unlock($1::bigint)", [ADVISORY_LOCK_KEY]);
    }
  } finally {
    client.release();
  }
}

async function ensureMigrationsTable(client: PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    text PRIMARY KEY,
      name       text NOT NULL,
      checksum   text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);
}

async function appliedMigrations(client: PoolClient): Promise<Map<string, AppliedRow>> {
  const result = await client.query<AppliedRow>(
    "SELECT version, checksum FROM schema_migrations ORDER BY version",
  );
  return new Map(result.rows.map((row) => [row.version, row]));
}

function verifyApplied(migrations: Migration[], applied: Map<string, AppliedRow>): void {
  for (const row of applied.values()) {
    const migration = migrations.find((m) => m.version === row.version);
    if (!migration) {
      throw new MigrationError(`migration ${row.version} is applied but its file is missing`);
    }
    if (migration.checksum !== row.checksum) {
      throw new MigrationError(`migration ${row.version}_${migration.name} changed after it was applied`);
    }
  }
}

async function applyMigration(client: PoolClient, migration: Migration): Promise<void> {
  await client.query("BEGIN");
  try {
    await client.query(migration.sql);
    await client.query(
      "INSERT INTO schema_migrations (version, name, checksum) VALUES ($1, $2, $3)",
      [migration.version, migration.name, migration.checksum],
    );
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw new MigrationError(
      `migration ${migration.version}_${migration.name} failed: ${(err as Error).message}`,
      { cause: err },
    );
  }
}
