import type { Hlc, PullResponse } from "@sync/shared";
import type { DocsStore } from "../store/docsStore.js";
import type { SqliteDatabase } from "../store/database.js";
import type { MetaStore } from "../store/metaStore.js";
import { InvalidResponseError } from "../transport/errors.js";
import type { SyncTransport } from "../transport/transport.js";
import { applyRemoteEvents } from "./applyRemote.js";
import type { DocumentChange } from "./changes.js";

export interface PullContext {
  readonly db: SqliteDatabase;
  readonly docs: DocsStore;
  readonly meta: MetaStore;
  readonly hlc: Hlc;
  readonly transport: SyncTransport;
  readonly limit: number;
  /** Called after each page is committed with the documents it changed. */
  readonly onChanges: (changes: DocumentChange[]) => void;
}

export interface PullOutcome {
  /** Events received. */
  readonly pulled: number;
  /** Field writes that replaced a local value. */
  readonly applied: number;
  readonly pages: number;
}

/**
 * Reject a page that breaks the protocol before anything is applied: events must follow
 * `after` in strictly ascending order, `nextAfter` must be the last of them, and a page that
 * announces more must make progress (otherwise the loop below would never end).
 */
export function checkPage(page: PullResponse, after: number, limit: number): void {
  const fail = (message: string): never => {
    throw new InvalidResponseError(`invalid pull page after ${after}: ${message}`);
  };
  if (page.events.length > limit) fail(`${page.events.length} events for a limit of ${limit}`);
  let previous = after;
  for (const event of page.events) {
    if (event.seq <= previous) fail(`event ${event.seq} does not follow ${previous}`);
    previous = event.seq;
  }
  if (page.nextAfter !== previous) fail(`nextAfter is ${page.nextAfter}, expected ${previous}`);
  if (page.hasMore && page.events.length === 0) fail("hasMore without events");
}

/**
 * Pull pages until the server has no more. Each page is applied in one transaction together
 * with its cursor, so after a crash or a failed request the next pull starts exactly after the
 * last page that was applied: no event is applied twice or skipped.
 */
export async function pullChanges(ctx: PullContext): Promise<PullOutcome> {
  let after = ctx.meta.pullAfter();
  let pulled = 0;
  let applied = 0;
  let pages = 0;
  for (;;) {
    const page = await ctx.transport.pull({ after, limit: ctx.limit });
    checkPage(page, after, ctx.limit);
    const result = ctx.db.transaction(() => {
      const outcome = applyRemoteEvents(ctx.docs, ctx.hlc, page.events);
      ctx.meta.setPullAfter(page.nextAfter);
      ctx.meta.setLastHlc(ctx.hlc.last);
      return outcome;
    })();
    pages += 1;
    pulled += page.events.length;
    applied += result.applied;
    after = page.nextAfter;
    if (result.changes.length > 0) ctx.onChanges(result.changes);
    if (!page.hasMore) break;
  }
  return { pulled, applied, pages };
}
