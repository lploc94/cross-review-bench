import type { DocState } from "@sync/shared";
import type { Statement } from "better-sqlite3";
import type { SqliteDatabase } from "./database.js";
import { parseJsonObject } from "./errors.js";

export interface StoredDoc extends DocState {
  readonly collection: string;
  readonly id: string;
}

interface DocRow {
  collection: string;
  id: string;
  fields: string;
  field_hlcs: string;
}

function toDoc(row: DocRow): StoredDoc {
  const where = `document ${row.collection}/${row.id}`;
  return {
    collection: row.collection,
    id: row.id,
    fields: parseJsonObject<unknown>(row.fields, `fields of ${where}`),
    fieldHlcs: parseJsonObject<string>(row.field_hlcs, `field timestamps of ${where}`),
  };
}

/** The `docs` table: the local replica of every document. */
export class DocsStore {
  private readonly selectOne: Statement<[string, string], DocRow>;
  private readonly selectCollection: Statement<[string], DocRow>;
  private readonly selectPage: Statement<[string, string, number], DocRow>;
  private readonly upsert: Statement<[string, string, string, string]>;
  private readonly countCollection: Statement<[string], { count: number }>;

  constructor(db: SqliteDatabase) {
    this.selectOne = db.prepare(
      "SELECT collection, id, fields, field_hlcs FROM docs WHERE collection = ? AND id = ?",
    );
    this.selectCollection = db.prepare(
      "SELECT collection, id, fields, field_hlcs FROM docs WHERE collection = ? ORDER BY id",
    );
    this.selectPage = db.prepare(
      "SELECT collection, id, fields, field_hlcs FROM docs WHERE collection = ? AND id > ? ORDER BY id LIMIT ?",
    );
    this.upsert = db.prepare(
      `INSERT INTO docs (collection, id, fields, field_hlcs) VALUES (?, ?, ?, ?)
       ON CONFLICT (collection, id) DO UPDATE SET fields = excluded.fields, field_hlcs = excluded.field_hlcs`,
    );
    this.countCollection = db.prepare("SELECT count(*) AS count FROM docs WHERE collection = ?");
  }

  get(collection: string, id: string): StoredDoc | null {
    const row = this.selectOne.get(collection, id);
    return row ? toDoc(row) : null;
  }

  /** Every document of the collection, by id. */
  list(collection: string): StoredDoc[] {
    return this.selectCollection.all(collection).map(toDoc);
  }

  /** At most `limit` documents of the collection with ids after `afterId`, by id. */
  listPage(collection: string, afterId: string | null, limit: number): StoredDoc[] {
    // Every id sorts after the empty string.
    return this.selectPage.all(collection, afterId ?? "", limit).map(toDoc);
  }

  put(collection: string, id: string, state: DocState): void {
    this.upsert.run(collection, id, JSON.stringify(state.fields), JSON.stringify(state.fieldHlcs));
  }

  count(collection: string): number {
    return this.countCollection.get(collection)?.count ?? 0;
  }
}
