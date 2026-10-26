import Database from "better-sqlite3";

export type SqliteDatabase = Database.Database;

export const IN_MEMORY = ":memory:";

/**
 * Open (or create) the local database. A file database uses write-ahead logging, so readers in
 * other connections are not blocked by a sync writing; a busy database is waited for up to five
 * seconds before an operation fails.
 */
export function openDatabase(path: string): SqliteDatabase {
  const db = new Database(path);
  try {
    db.pragma("foreign_keys = ON");
    db.pragma("busy_timeout = 5000");
    if (path !== IN_MEMORY) db.pragma("journal_mode = WAL");
    return db;
  } catch (err) {
    db.close();
    throw err;
  }
}
