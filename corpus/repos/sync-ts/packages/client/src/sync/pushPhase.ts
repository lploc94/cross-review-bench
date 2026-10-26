import { parseHlc, type Hlc, type MutationPayload } from "@sync/shared";
import type { SqliteDatabase } from "../store/database.js";
import type { MetaStore } from "../store/metaStore.js";
import type { OutboxEntry, OutboxStore } from "../store/outboxStore.js";
import type { SyncTransport } from "../transport/transport.js";

export interface PushContext {
  readonly db: SqliteDatabase;
  readonly outbox: OutboxStore;
  readonly meta: MetaStore;
  readonly hlc: Hlc;
  readonly transport: SyncTransport;
  readonly batchSize: number;
}

export interface PushOutcome {
  /** Mutations the server acknowledged and that left the outbox. */
  readonly pushed: number;
  readonly batches: number;
}

function toPayload(entry: OutboxEntry): MutationPayload {
  return { ...entry.mutation, fields: entry.mutation.fields as MutationPayload["fields"] };
}

/**
 * Push the outbox in batches, oldest first. Acknowledged mutations leave the outbox; the others
 * stay for the next sync. Each batch is sent at most once per call, so a mutation the server
 * keeps not acknowledging cannot make this loop forever. A failed batch is counted against its
 * entries and the error is thrown: the outbox keeps every unacknowledged mutation, and sending
 * them again is safe because the server recognises mutation ids it has already recorded.
 */
export async function pushOutbox(ctx: PushContext): Promise<PushOutcome> {
  let afterSeq = 0;
  let pushed = 0;
  let batches = 0;
  for (;;) {
    const batch = ctx.outbox.batchAfter(afterSeq, ctx.batchSize);
    const last = batch.at(-1);
    if (!last) break;
    afterSeq = last.seq;
    batches += 1;

    let response;
    try {
      response = await ctx.transport.push({ mutations: batch.map(toPayload) });
    } catch (err) {
      ctx.outbox.recordFailure(
        batch.map((entry) => entry.seq),
        err instanceof Error ? err.message : String(err),
      );
      throw err;
    }

    const sent = new Set(batch.map((entry) => entry.mutation.mutationId));
    const acked = response.acked.filter((id) => sent.has(id));
    pushed += ctx.outbox.remove(acked);
    // After the acknowledged mutations are gone: a server clock too far ahead must not keep
    // them in the outbox.
    ctx.hlc.receive(parseHlc(response.serverHlc));
    ctx.meta.setLastHlc(ctx.hlc.last);
  }
  return { pushed, batches };
}
