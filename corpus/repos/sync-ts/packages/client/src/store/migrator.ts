import type { SqliteDatabase } from "./database.js";
import { SchemaVersionError } from "./errors.js";
import { CLIENT_MIGRATIONS, type SchemaMigration } from "./schema.js";

export interface MigrationOutcome {
  readonly from: number;
  readonly to: number;
}

export function schemaVersion(db: SqliteDatabase): number {
  const version: unknown = db.pragma("user_version", { simple: true });
  if (typeof version !== "number" || !Number.isInteger(version) || version < 0) {
    throw new TypeError(`unexpected user_version ${String(version)}`);
  }
  return version;
}

function checkSequence(migrations: readonly SchemaMigration[]): void {
  migrations.forEach((migration, index) => {
    if (migration.version !== index + 1) {
      throw new RangeError(
        `client migrations must be numbered 1, 2, 3…; found version ${migration.version} at position ${index + 1}`,
      );
    }
  });
}

/**
 * Bring the database to the latest schema. Each migration runs in its own IMMEDIATE transaction
 * together with the new `user_version`, so a failed migration leaves the previous version intact
 * and two processes opening the same file cannot both apply it. A database from a newer client
 * is refused rather than written to.
 */
export function migrate(
  db: SqliteDatabase,
  migrations: readonly SchemaMigration[] = CLIENT_MIGRATIONS,
): MigrationOutcome {
  checkSequence(migrations);
  const latest = migrations.length;
  const from = schemaVersion(db);
  if (from > latest) throw new SchemaVersionError(from, latest);
  for (const migration of migrations.slice(from)) {
    db.transaction(() => {
      // Another connection may have migrated since the version was read.
      if (schemaVersion(db) >= migration.version) return;
      migration.up(db);
      db.pragma(`user_version = ${migration.version}`);
    }).immediate();
  }
  return { from, to: schemaVersion(db) };
}
