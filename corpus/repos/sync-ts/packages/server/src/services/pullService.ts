import type { PhysicalClock } from "@sync/shared";
import type { Pool } from "../db/pool.js";
import type { AuthContext } from "../domain/accounts.js";
import { findCursor, recordCursor } from "../repositories/cursors.js";
import { latestSeq, listEventsAfter, type StoredEvent } from "../repositories/events.js";

export interface SyncStatus {
  readonly latestSeq: number;
  readonly cursor: number | null;
}

export interface PullPage {
  /** Events with `seq > after`, at most `limit`, in seq order. */
  readonly events: StoredEvent[];
  /** What the device should send as `after` next: the last event's seq, or `after`. */
  readonly nextAfter: number;
  /** Whether events beyond this page exist already. */
  readonly hasMore: boolean;
}

/**
 * Serves the change feed of the caller's user. Pulling with `after = N` also confirms that the
 * device has applied every event up to N, which is recorded as the device's cursor.
 */
export class PullService {
  private readonly pool: Pool;
  private readonly clock: PhysicalClock;

  constructor(deps: { pool: Pool; clock: PhysicalClock }) {
    this.pool = deps.pool;
    this.clock = deps.clock;
  }

  async pull(auth: AuthContext, after: number, limit: number): Promise<PullPage> {
    // One row more than the page tells whether another page follows.
    const rows = await listEventsAfter(this.pool, auth.userId, after, limit + 1);
    const hasMore = rows.length > limit;
    const events = hasMore ? rows.slice(0, limit) : rows;
    await recordCursor(this.pool, auth.deviceId, after, new Date(this.clock.now()));
    return { events, nextAfter: events.at(-1)?.seq ?? after, hasMore };
  }

  /** How far the device is behind its user's change feed. */
  async status(auth: AuthContext): Promise<SyncStatus> {
    const [latest, cursor] = await Promise.all([
      latestSeq(this.pool, auth.userId),
      findCursor(this.pool, auth.deviceId),
    ]);
    return { latestSeq: latest, cursor };
  }
}
