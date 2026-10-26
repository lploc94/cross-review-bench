import type { SqliteDatabase } from "./database.js";

/**
 * The client's schema, versioned with `PRAGMA user_version`. Each migration moves the database
 * from `version - 1` to `version`; the migrator applies the missing ones in order.
 */
export interface SchemaMigration {
  readonly version: number;
  readonly description: string;
  up(db: SqliteDatabase): void;
}

const V1 = `
  -- The local replica: every document's fields and, per field, the HLC of the write that set it.
  CREATE TABLE docs (
    collection TEXT NOT NULL,
    id         TEXT NOT NULL,
    fields     TEXT NOT NULL,
    field_hlcs TEXT NOT NULL,
    PRIMARY KEY (collection, id)
  ) WITHOUT ROWID;

  -- Local mutations not yet acknowledged by the server, in the order they were made.
  CREATE TABLE outbox (
    seq         INTEGER PRIMARY KEY AUTOINCREMENT,
    mutation_id TEXT NOT NULL UNIQUE,
    collection  TEXT NOT NULL,
    doc_id      TEXT NOT NULL,
    fields      TEXT NOT NULL,
    hlc         TEXT NOT NULL,
    attempts    INTEGER NOT NULL DEFAULT 0,
    last_error  TEXT
  );

  -- Small client state: the pull cursor, the last HLC, the node id.
  CREATE TABLE meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  ) WITHOUT ROWID;
`;

export const CLIENT_MIGRATIONS: readonly SchemaMigration[] = [
  {
    version: 1,
    description: "docs, outbox and meta",
    up: (db) => db.exec(V1),
  },
];

export const CLIENT_SCHEMA_VERSION = CLIENT_MIGRATIONS.length;
