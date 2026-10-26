import {
  CLIENT_SCHEMA_VERSION,
  IN_MEMORY,
  SchemaVersionError,
  migrate,
  openDatabase,
  schemaVersion,
  type SchemaMigration,
} from "@sync/client";
import { describe, expect, it } from "vitest";
import { tempDbPath } from "../helpers/tempFiles.js";

function tables(db: ReturnType<typeof openDatabase>): string[] {
  return db
    .prepare<[], { name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all()
    .map((row) => row.name);
}

describe("client schema migrator", () => {
  it("creates the schema on a new database", () => {
    const db = openDatabase(IN_MEMORY);
    expect(migrate(db)).toEqual({ from: 0, to: CLIENT_SCHEMA_VERSION });
    expect(tables(db)).toEqual(["docs", "meta", "outbox"]);
    expect(schemaVersion(db)).toBe(1);
    db.close();
  });

  it("does nothing on an up-to-date database", () => {
    const path = tempDbPath();
    const first = openDatabase(path);
    migrate(first);
    first.close();
    const again = openDatabase(path);
    expect(migrate(again)).toEqual({ from: 1, to: 1 });
    again.close();
  });

  it("applies later migrations in order", () => {
    const db = openDatabase(IN_MEMORY);
    migrate(db);
    const steps: SchemaMigration[] = [
      { version: 1, description: "base", up: () => expect.unreachable() },
      { version: 2, description: "add a table", up: (d) => d.exec("CREATE TABLE extra (id TEXT)") },
      { version: 3, description: "add a column", up: (d) => d.exec("ALTER TABLE extra ADD COLUMN n INTEGER") },
    ];
    expect(migrate(db, steps)).toEqual({ from: 1, to: 3 });
    expect(tables(db)).toContain("extra");
    db.close();
  });

  it("leaves the previous version intact when a migration fails", () => {
    const db = openDatabase(IN_MEMORY);
    migrate(db);
    const steps: SchemaMigration[] = [
      { version: 1, description: "base", up: () => undefined },
      {
        version: 2,
        description: "fails halfway",
        up: (d) => {
          d.exec("CREATE TABLE half (id TEXT)");
          throw new Error("disk full");
        },
      },
    ];
    expect(() => migrate(db, steps)).toThrow("disk full");
    expect(schemaVersion(db)).toBe(1);
    expect(tables(db)).not.toContain("half");
    db.close();
  });

  it("refuses a database written by a newer client", () => {
    const db = openDatabase(IN_MEMORY);
    db.pragma("user_version = 7");
    expect(() => migrate(db)).toThrow(SchemaVersionError);
    db.close();
  });

  it("requires migrations numbered from 1 without gaps", () => {
    const db = openDatabase(IN_MEMORY);
    const gap: SchemaMigration[] = [
      { version: 1, description: "a", up: () => undefined },
      { version: 3, description: "c", up: () => undefined },
    ];
    expect(() => migrate(db, gap)).toThrow(RangeError);
    db.close();
  });
});
