import type { Mutation } from "@sync/shared";
import type { Statement } from "better-sqlite3";
import type { SqliteDatabase } from "./database.js";
import { parseJsonObject } from "./errors.js";

/** A local mutation waiting for the server's acknowledgement. */
export interface OutboxEntry {
  /** Local order of the mutation; never reused. */
  readonly seq: number;
  readonly mutation: Mutation;
  /** Pushes of this mutation that failed. */
  readonly attempts: number;
  readonly lastError: string | null;
}

interface OutboxRow {
  seq: number;
  mutation_id: string;
  collection: string;
  doc_id: string;
  fields: string;
  hlc: string;
  attempts: number;
  last_error: string | null;
}

function toEntry(row: OutboxRow): OutboxEntry {
  return {
    seq: row.seq,
    mutation: {
      mutationId: row.mutation_id,
      collection: row.collection,
      docId: row.doc_id,
      op: "set",
      fields: parseJsonObject<unknown>(row.fields, `fields of outbox entry ${row.seq}`),
      hlc: row.hlc,
    },
    attempts: row.attempts,
    lastError: row.last_error,
  };
}

const COLUMNS = "seq, mutation_id, collection, doc_id, fields, hlc, attempts, last_error";
/** Longest error message kept in `last_error`. */
const MAX_ERROR_LENGTH = 500;

/** The `outbox` table: mutations in the order they were made, until the server acknowledges them. */
export class OutboxStore {
  private readonly db: SqliteDatabase;
  private readonly insert: Statement<[string, string, string, string, string]>;
  private readonly selectAfter: Statement<[number, number], OutboxRow>;
  private readonly deleteByMutationId: Statement<[string]>;
  private readonly markFailed: Statement<[string, number]>;
  private readonly countAll: Statement<[], { count: number }>;

  constructor(db: SqliteDatabase) {
    this.db = db;
    this.insert = db.prepare(
      "INSERT INTO outbox (mutation_id, collection, doc_id, fields, hlc) VALUES (?, ?, ?, ?, ?)",
    );
    this.selectAfter = db.prepare(`SELECT ${COLUMNS} FROM outbox WHERE seq > ? ORDER BY seq LIMIT ?`);
    this.deleteByMutationId = db.prepare("DELETE FROM outbox WHERE mutation_id = ?");
    this.markFailed = db.prepare(
      "UPDATE outbox SET attempts = attempts + 1, last_error = ? WHERE seq = ?",
    );
    this.countAll = db.prepare("SELECT count(*) AS count FROM outbox");
  }

  /** Queue a mutation; returns its seq. */
  append(mutation: Mutation): number {
    const result = this.insert.run(
      mutation.mutationId,
      mutation.collection,
      mutation.docId,
      JSON.stringify(mutation.fields),
      mutation.hlc,
    );
    return Number(result.lastInsertRowid);
  }

  /** Up to `limit` entries with `seq > afterSeq`, oldest first. */
  batchAfter(afterSeq: number, limit: number): OutboxEntry[] {
    return this.selectAfter.all(afterSeq, limit).map(toEntry);
  }

  /** Remove acknowledged mutations; returns how many rows were removed. */
  remove(mutationIds: readonly string[]): number {
    return this.db.transaction(() => {
      let removed = 0;
      for (const id of mutationIds) removed += this.deleteByMutationId.run(id).changes;
      return removed;
    })();
  }

  /** Count a failed push against each entry and keep the error for inspection. */
  recordFailure(seqs: readonly number[], message: string): void {
    const kept = message.length > MAX_ERROR_LENGTH ? `${message.slice(0, MAX_ERROR_LENGTH - 1)}…` : message;
    this.db.transaction(() => {
      for (const seq of seqs) this.markFailed.run(kept, seq);
    })();
  }

  count(): number {
    return this.countAll.get()?.count ?? 0;
  }
}
