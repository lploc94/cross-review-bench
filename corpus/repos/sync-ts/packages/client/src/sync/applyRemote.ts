import {
  EMPTY_DOC_STATE,
  docKey,
  isCollectionName,
  isValidFieldValue,
  mergeWrites,
  parseHlc,
  type CollectionName,
  type FieldWrite,
  type Hlc,
  type SyncEvent,
} from "@sync/shared";
import type { DocsStore } from "../store/docsStore.js";
import { InvalidResponseError } from "../transport/errors.js";
import type { DocumentChange } from "./changes.js";

export interface RemoteApplyResult {
  readonly changes: DocumentChange[];
  /** Field writes that replaced the local value. */
  readonly applied: number;
}

interface PendingDoc {
  readonly collection: CollectionName;
  readonly id: string;
  readonly writes: FieldWrite[];
}

/**
 * Apply pulled events to the replica with the same per-field last-writer-wins as the server, and
 * merge each event's timestamp into the local clock. A write older than the local value of its
 * field (a local change not pushed yet, or the echo of this replica's own write) is skipped.
 * Run inside the transaction that also stores the pull cursor.
 */
export function applyRemoteEvents(docs: DocsStore, hlc: Hlc, events: readonly SyncEvent[]): RemoteApplyResult {
  const pending = new Map<string, PendingDoc>();
  for (const event of events) {
    if (!isCollectionName(event.collection) || !isValidFieldValue(event.collection, event.field, event.value)) {
      throw new InvalidResponseError(
        `event ${event.seq} writes ${event.collection}.${event.field}, which this client does not know or cannot hold`,
        { details: { seq: event.seq, collection: event.collection, field: event.field } },
      );
    }
    hlc.receive(parseHlc(event.hlc));
    const key = docKey(event.collection, event.docId);
    let doc = pending.get(key);
    if (!doc) {
      doc = { collection: event.collection, id: event.docId, writes: [] };
      pending.set(key, doc);
    }
    doc.writes.push({ field: event.field, value: event.value, hlc: event.hlc });
  }

  const changes: DocumentChange[] = [];
  let applied = 0;
  for (const doc of pending.values()) {
    const current = docs.get(doc.collection, doc.id) ?? EMPTY_DOC_STATE;
    const merged = mergeWrites(current, doc.writes);
    if (merged.applied.length === 0) continue;
    docs.put(doc.collection, doc.id, merged.state);
    applied += merged.applied.length;
    changes.push({
      collection: doc.collection,
      id: doc.id,
      fields: merged.state.fields,
      changedFields: [...new Set(merged.applied.map((w) => w.field))].sort(),
      source: "remote",
    });
  }
  return { changes, applied };
}
