import {
  EMPTY_DOC_STATE,
  docKey,
  jsonEqual,
  mergeWrites,
  type DocState,
} from "@sync/shared";
import type { Pool, PoolClient } from "../db/pool.js";
import { withTransaction } from "../db/tx.js";
import { listDocumentsPage, type StoredDocument } from "../repositories/documents.js";
import { listEventsAfter } from "../repositories/events.js";

export type ConsistencyProblem =
  | { readonly kind: "event_does_not_win"; readonly seq: number; readonly doc: string; readonly field: string }
  | { readonly kind: "missing_document"; readonly doc: string }
  | { readonly kind: "unexpected_document"; readonly doc: string }
  | { readonly kind: "field_mismatch"; readonly doc: string; readonly field: string }
  | { readonly kind: "updated_seq_mismatch"; readonly doc: string; readonly expected: number; readonly actual: number };

export interface ConsistencyReport {
  readonly userId: string;
  readonly events: number;
  readonly documents: number;
  /** The first `maxProblems` problems found. */
  readonly problems: ConsistencyProblem[];
  /** Whether more problems were found than reported. */
  readonly truncated: boolean;
}

interface Replayed {
  state: DocState;
  lastSeq: number;
  seen: boolean;
}

/**
 * Checks that the materialised documents of a user are what the change feed says they are:
 * replaying every event in seq order with last-writer-wins must accept each event (each one won
 * when it was written) and end with exactly the stored documents. Reads one consistent snapshot
 * page by page; the replayed documents are held in memory, so it is meant for operators
 * checking one user, not for a request path.
 */
export class ConsistencyService {
  private readonly pool: Pool;
  private readonly pageSize: number;
  private readonly maxProblems: number;

  constructor(deps: { pool: Pool; pageSize?: number; maxProblems?: number }) {
    this.pool = deps.pool;
    this.pageSize = deps.pageSize ?? 1_000;
    this.maxProblems = deps.maxProblems ?? 100;
  }

  async verifyUser(userId: string): Promise<ConsistencyReport> {
    return withTransaction(
      this.pool,
      async (client) => {
        await client.query("SET TRANSACTION READ ONLY");
        const problems: ConsistencyProblem[] = [];
        let found = 0;
        const report = (problem: ConsistencyProblem): void => {
          found += 1;
          if (problems.length < this.maxProblems) problems.push(problem);
        };
        const { replayed, events } = await this.replayEvents(client, userId, report);
        const documents = await this.compareDocuments(client, userId, replayed, report);
        for (const [key, doc] of replayed) {
          if (!doc.seen) report({ kind: "missing_document", doc: key });
        }
        return { userId, events, documents, problems, truncated: found > problems.length };
      },
      { isolation: "repeatable read" },
    );
  }

  private async replayEvents(
    client: PoolClient,
    userId: string,
    report: (problem: ConsistencyProblem) => void,
  ): Promise<{ replayed: Map<string, Replayed>; events: number }> {
    const replayed = new Map<string, Replayed>();
    let after = 0;
    let events = 0;
    for (;;) {
      const page = await listEventsAfter(client, userId, after, this.pageSize);
      for (const event of page) {
        const key = docKey(event.collection, event.docId);
        const doc = replayed.get(key) ?? { state: EMPTY_DOC_STATE, lastSeq: 0, seen: false };
        const merged = mergeWrites(doc.state, [{ field: event.field, value: event.value, hlc: event.hlc }]);
        if (merged.applied.length === 0) {
          report({ kind: "event_does_not_win", seq: event.seq, doc: key, field: event.field });
        }
        replayed.set(key, { state: merged.state, lastSeq: event.seq, seen: false });
      }
      events += page.length;
      const last = page.at(-1);
      if (!last || page.length < this.pageSize) break;
      after = last.seq;
    }
    return { replayed, events };
  }

  private async compareDocuments(
    client: PoolClient,
    userId: string,
    replayed: Map<string, Replayed>,
    report: (problem: ConsistencyProblem) => void,
  ): Promise<number> {
    let after: StoredDocument | null = null;
    let documents = 0;
    for (;;) {
      const page: StoredDocument[] = await listDocumentsPage(client, userId, after, this.pageSize);
      for (const doc of page) {
        const key = docKey(doc.collection, doc.docId);
        const expected = replayed.get(key);
        if (!expected) {
          report({ kind: "unexpected_document", doc: key });
          continue;
        }
        expected.seen = true;
        const fields = new Set([...Object.keys(expected.state.fields), ...Object.keys(doc.fields)]);
        for (const field of [...fields].sort()) {
          const sameValue =
            Object.hasOwn(doc.fields, field) &&
            Object.hasOwn(expected.state.fields, field) &&
            jsonEqual(doc.fields[field], expected.state.fields[field]);
          if (!sameValue || ownValue(doc.fieldHlcs, field) !== ownValue(expected.state.fieldHlcs, field)) {
            report({ kind: "field_mismatch", doc: key, field });
          }
        }
        if (doc.updatedSeq !== expected.lastSeq) {
          report({ kind: "updated_seq_mismatch", doc: key, expected: expected.lastSeq, actual: doc.updatedSeq });
        }
      }
      documents += page.length;
      const last = page.at(-1);
      if (!last || page.length < this.pageSize) break;
      after = last;
    }
    return documents;
  }
}

function ownValue<T>(record: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}
