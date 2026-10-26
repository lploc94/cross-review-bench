import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadMigrations, MigrationError, runMigrations } from "../../src/db/migrate.js";
import { testPool } from "../helpers/db.js";

const tempDirs: string[] = [];

async function migrationsDir(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "sync-migrations-"));
  tempDirs.push(dir);
  for (const [name, sql] of Object.entries(files)) await writeFile(path.join(dir, name), sql);
  return dir;
}

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe("migrations", () => {
  it("are already applied by the global setup, so a second run applies nothing", async () => {
    expect(await runMigrations(testPool())).toEqual([]);
  });

  it("load in version order and ignore other files", async () => {
    const dir = await migrationsDir({
      "0002_second.sql": "SELECT 2;",
      "0001_first.sql": "SELECT 1;",
      "README.txt": "not a migration",
    });
    const migrations = await loadMigrations(dir);
    expect(migrations.map((m) => `${m.version}_${m.name}`)).toEqual(["0001_first", "0002_second"]);
    expect(migrations[0]?.checksum).toMatch(/^[0-9a-f]{64}$/);
  });

  it("refuse two files with the same version", async () => {
    const dir = await migrationsDir({ "0001_a.sql": "SELECT 1;", "0001_b.sql": "SELECT 1;" });
    await expect(loadMigrations(dir)).rejects.toThrow(MigrationError);
  });

  it("stop when an applied migration's file changed", async () => {
    const dir = await migrationsDir({ "0001_users_and_devices.sql": "SELECT 1;" });
    await expect(runMigrations(testPool(), { directory: dir })).rejects.toThrow(/changed after it was applied/);
  });

  it("stop when an applied migration's file is missing", async () => {
    const dir = await migrationsDir({ "0099_later.sql": "SELECT 1;" });
    await expect(runMigrations(testPool(), { directory: dir })).rejects.toThrow(/0001 is applied but its file is missing/);
  });

  it("create the expected tables", async () => {
    const result = await testPool().query<{ tablename: string }>(
      "SELECT tablename FROM pg_tables WHERE schemaname = current_schema() ORDER BY tablename",
    );
    expect(result.rows.map((r) => r.tablename)).toEqual([
      "device_cursors",
      "devices",
      "documents",
      "events",
      "mutations",
      "schema_migrations",
      "users",
    ]);
  });
});
