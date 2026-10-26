import {
  ClockDriftError,
  EMPTY_DOC_STATE,
  HlcCounterOverflowError,
  checkFieldWrites,
  docKey,
  fieldWritesOf,
  formatHlc,
  mergeWrites,
  parseHlc,
  type DocState,
  type Hlc,
  type HlcTimestamp,
  type MutationPayload,
  type PhysicalClock,
} from "@sync/shared";
import type { Pool } from "../db/pool.js";
import { withTransaction } from "../db/tx.js";
import type { AuthContext } from "../domain/accounts.js";
import {
  ClockDriftRejectedError,
  InvalidMutationError,
  UnauthorizedError,
  UnavailableError,
} from "../domain/errors.js";
import type { Logger } from "../infra/logger.js";
import { saveDocuments, loadDocuments, type DocRef, type DocumentWrite } from "../repositories/documents.js";
import { insertEvents, type NewEvent } from "../repositories/events.js";
import { claimMutations } from "../repositories/mutations.js";
import { lockUser } from "../repositories/users.js";

export interface PushResult {
  /** Every mutation id of the request, in request order. */
  readonly acked: string[];
  /** The server clock after receiving the mutations, as a canonical HLC string. */
  readonly serverHlc: string;
  /** Mutations seen for the first time (the others were acknowledged before). */
  readonly fresh: number;
  /** Events written: field writes that won last-writer-wins. */
  readonly applied: number;
}

/** A mutation whose fields passed the collection's schema. */
interface CheckedMutation extends Omit<MutationPayload, "fields"> {
  readonly fields: Record<string, unknown>;
}

/**
 * Applies pushed mutations. One request is one transaction: mutations already recorded are
 * acknowledged without being applied again; the others are recorded, merged field by field into
 * the stored documents (last writer wins by HLC), and every field write that wins becomes an
 * event. A request with an invalid mutation changes nothing.
 */
export class PushService {
  private readonly pool: Pool;
  private readonly clock: PhysicalClock;
  private readonly hlc: Hlc;
  private readonly logger: Logger;

  constructor(deps: { pool: Pool; clock: PhysicalClock; hlc: Hlc; logger: Logger }) {
    this.pool = deps.pool;
    this.clock = deps.clock;
    this.hlc = deps.hlc;
    this.logger = deps.logger;
  }

  async push(auth: AuthContext, mutations: readonly MutationPayload[]): Promise<PushResult> {
    const checked = this.check(mutations);
    this.receiveTimestamps(checked);
    // Taken before the transaction, so nothing can fail between the commit and the answer.
    const serverHlc = formatHlc(this.tick(() => this.hlc.now()));
    const receivedAt = new Date(this.clock.now());

    const { fresh, events } = await withTransaction(this.pool, async (client) => {
      // Pushes of one user run one at a time: their events get sequence numbers in commit
      // order, so a pull that has seen seq N can never later miss an event below N.
      if (!(await lockUser(client, auth.userId))) {
        throw new UnauthorizedError("the device's user no longer exists");
      }
      const claimed = await claimMutations(client, auth.userId, auth.deviceId, checked, receivedAt);
      const freshMutations = checked.filter((m) => claimed.has(m.mutationId));
      const refs = uniqueDocs(freshMutations);
      const stored = await loadDocuments(client, auth.userId, refs);
      const states = new Map<string, DocState>(
        [...stored].map(([key, doc]) => [key, { fields: doc.fields, fieldHlcs: doc.fieldHlcs }]),
      );

      const newEvents: NewEvent[] = [];
      for (const mutation of freshMutations) {
        const key = docKey(mutation.collection, mutation.docId);
        const merged = mergeWrites(states.get(key) ?? EMPTY_DOC_STATE, fieldWritesOf(mutation));
        states.set(key, merged.state);
        for (const write of merged.applied) {
          newEvents.push({
            mutationId: mutation.mutationId,
            collection: mutation.collection,
            docId: mutation.docId,
            field: write.field,
            value: write.value,
            hlc: write.hlc,
          });
        }
      }

      const inserted = await insertEvents(client, auth.userId, auth.deviceId, newEvents, receivedAt);
      const lastSeq = new Map<string, number>();
      for (const event of inserted) {
        const key = docKey(event.collection, event.docId);
        lastSeq.set(key, Math.max(lastSeq.get(key) ?? 0, event.seq));
      }
      const writes: DocumentWrite[] = [];
      for (const ref of refs) {
        const key = docKey(ref.collection, ref.docId);
        const seq = lastSeq.get(key);
        const state = states.get(key);
        // A document none of whose writes won is left as it is.
        if (seq === undefined || !state) continue;
        writes.push({ ...ref, ...state, updatedSeq: seq });
      }
      await saveDocuments(client, auth.userId, writes, receivedAt);
      return { fresh: freshMutations.length, events: inserted.length };
    });

    this.logger.debug(
      { userId: auth.userId, deviceId: auth.deviceId, mutations: checked.length, fresh, events },
      "push applied",
    );
    return { acked: checked.map((m) => m.mutationId), serverHlc, fresh, applied: events };
  }

  /** Validate every mutation against its collection; the first invalid one rejects the request. */
  private check(mutations: readonly MutationPayload[]): CheckedMutation[] {
    const seen = new Set<string>();
    return mutations.map((mutation, index) => {
      if (seen.has(mutation.mutationId)) {
        throw new InvalidMutationError(
          index,
          mutation.mutationId,
          [{ field: "", message: "the mutation id appears twice in this request" }],
          `mutation ${index} (${mutation.mutationId}) repeats an earlier mutation id of the request`,
        );
      }
      seen.add(mutation.mutationId);
      const result = checkFieldWrites(mutation.collection, mutation.fields);
      if (!result.ok) throw new InvalidMutationError(index, mutation.mutationId, result.issues);
      return { ...mutation, fields: result.fields };
    });
  }

  /** Merge every mutation's timestamp into the server clock; one too far ahead rejects the request. */
  private receiveTimestamps(mutations: readonly CheckedMutation[]): void {
    mutations.forEach((mutation, index) => {
      try {
        this.tick(() => this.hlc.receive(parseHlc(mutation.hlc)));
      } catch (err) {
        if (err instanceof ClockDriftError) {
          throw new ClockDriftRejectedError(
            index,
            mutation.mutationId,
            err.remoteWallMs - err.physicalMs,
            err.maxDriftMs,
          );
        }
        throw err;
      }
    });
  }

  /** Run a clock operation; a counter overflow is a 503 (it clears as soon as time moves on). */
  private tick(operation: () => HlcTimestamp): HlcTimestamp {
    try {
      return operation();
    } catch (err) {
      if (err instanceof HlcCounterOverflowError) {
        throw new UnavailableError("the server clock cannot take more timestamps this millisecond");
      }
      throw err;
    }
  }
}

/** The documents the mutations write, each once, in first-seen order. */
function uniqueDocs(mutations: readonly Pick<MutationPayload, "collection" | "docId">[]): DocRef[] {
  const refs = new Map<string, DocRef>();
  for (const m of mutations) {
    const key = docKey(m.collection, m.docId);
    if (!refs.has(key)) refs.set(key, { collection: m.collection, docId: m.docId });
  }
  return [...refs.values()];
}
