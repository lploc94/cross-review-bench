import type { Pool } from "../db/pool.js";
import type { DeviceWithCursor } from "../domain/accounts.js";
import { MAX_DEVICES_PER_USER } from "../domain/accounts.js";
import { listDevicesWithCursors } from "../repositories/devices.js";
import { countDocumentsByCollection } from "../repositories/documents.js";
import { countEvents, countEventsAfter, latestSeq } from "../repositories/events.js";

export interface UserStats {
  readonly latestSeq: number;
  readonly events: number;
  readonly documentsByCollection: ReadonlyMap<string, number>;
  /** Devices with how many events each still has to pull (null before its first pull). */
  readonly devices: readonly (DeviceWithCursor & { readonly behind: number | null })[];
}

/** Figures operators look at for one user: feed size, documents, how far each device lags. */
export class StatsService {
  private readonly pool: Pool;

  constructor(deps: { pool: Pool }) {
    this.pool = deps.pool;
  }

  async userStats(userId: string): Promise<UserStats> {
    const [latest, events, documentsByCollection, devices] = await Promise.all([
      latestSeq(this.pool, userId),
      countEvents(this.pool, userId),
      countDocumentsByCollection(this.pool, userId),
      listDevicesWithCursors(this.pool, userId, MAX_DEVICES_PER_USER),
    ]);
    const behind = await Promise.all(
      devices.map(async (device) =>
        device.lastPulledSeq === null ? null : countEventsAfter(this.pool, userId, device.lastPulledSeq),
      ),
    );
    return {
      latestSeq: latest,
      events,
      documentsByCollection,
      devices: devices.map((device, i) => ({ ...device, behind: behind[i] ?? null })),
    };
  }
}
