import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MigrationError, loadMigrations, runMigrations } from "../../src/db/migrate.js";
import { testPool } from "../helpers/db.js";

const dirs: string[] = [];

async function migrationsDir(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "uploads-migrations-"));
  dirs.push(dir);
  for (const [name, sql] of Object.entries(files)) {
    await writeFile(path.join(dir, name), sql);
  }
  return dir;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("migrations", () => {
  it("are all applied to the test database and running them again is a no-op", async () => {
    const files = await loadMigrations();
    const applied = await testPool().query<{ version: string }>(
      "SELECT version FROM schema_migrations ORDER BY version",
    );
    expect(applied.rows.map((row) => row.version)).toEqual(files.map((m) => m.version));
    expect(await runMigrations(testPool())).toEqual([]);
  });

  it("load files in version order and ignore other files", async () => {
    const dir = await migrationsDir({
      "0002_second.sql": "SELECT 2;",
      "0001_first.sql": "SELECT 1;",
      "notes.txt": "not a migration",
    });
    const migrations = await loadMigrations(dir);
    expect(migrations.map((m) => `${m.version}_${m.name}`)).toEqual(["0001_first", "0002_second"]);
  });

  it("refuse two files with one version", async () => {
    const dir = await migrationsDir({ "0001_a.sql": "SELECT 1;", "0001_b.sql": "SELECT 1;" });
    await expect(loadMigrations(dir)).rejects.toThrow(/share version 0001/);
  });

  it("refuse to run when an applied migration file has changed", async () => {
    const files = Object.fromEntries(
      (await loadMigrations()).map((m) => [`${m.version}_${m.name}.sql`, m.sql]),
    );
    files["0002_files.sql"] += "\n-- reworded\n";
    const dir = await migrationsDir(files);
    await expect(runMigrations(testPool(), { directory: dir })).rejects.toThrow(
      /0002_files changed after it was applied/,
    );
  });

  it("refuse to run when an applied migration file is missing", async () => {
    const dir = await migrationsDir({ "0001_tenants_and_api_keys.sql": "SELECT 1;" });
    await expect(runMigrations(testPool(), { directory: dir })).rejects.toThrow(MigrationError);
  });
});
