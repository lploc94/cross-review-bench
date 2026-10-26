import { InvalidHlcError, formatHlc, isValidNodeId, parseHlc, type HlcTimestamp } from "@sync/shared";
import type { Statement } from "better-sqlite3";
import type { SqliteDatabase } from "./database.js";
import { CorruptStoreError } from "./errors.js";

/** Keys of the `meta` table. */
export const META_KEYS = {
  /** The `after` of the next pull: the last server seq applied locally. */
  pullAfter: "pull_after",
  /** The last HLC this replica issued or received, so a restarted client never goes back. */
  lastHlc: "last_hlc",
  /** This replica's HLC node id, chosen once when the database is created. */
  nodeId: "node_id",
} as const;

/** Typed access to the client's small persistent state. */
export class MetaStore {
  private readonly selectValue: Statement<[string], { value: string }>;
  private readonly upsertValue: Statement<[string, string]>;

  constructor(db: SqliteDatabase) {
    this.selectValue = db.prepare("SELECT value FROM meta WHERE key = ?");
    this.upsertValue = db.prepare(
      "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
    );
  }

  get(key: string): string | null {
    return this.selectValue.get(key)?.value ?? null;
  }

  set(key: string, value: string): void {
    this.upsertValue.run(key, value);
  }

  pullAfter(): number {
    const value = this.get(META_KEYS.pullAfter);
    if (value === null) return 0;
    const after = /^\d{1,16}$/.test(value) ? Number(value) : Number.NaN;
    if (!Number.isSafeInteger(after)) throw new CorruptStoreError(`stored pull cursor ${value} is invalid`);
    return after;
  }

  setPullAfter(after: number): void {
    if (!Number.isSafeInteger(after) || after < 0) throw new RangeError(`invalid pull cursor ${after}`);
    this.set(META_KEYS.pullAfter, String(after));
  }

  lastHlc(): HlcTimestamp | null {
    const value = this.get(META_KEYS.lastHlc);
    if (value === null) return null;
    try {
      return parseHlc(value);
    } catch (err) {
      if (err instanceof InvalidHlcError) {
        throw new CorruptStoreError(`stored HLC ${value} is invalid`, { cause: err });
      }
      throw err;
    }
  }

  setLastHlc(ts: HlcTimestamp): void {
    this.set(META_KEYS.lastHlc, formatHlc(ts));
  }

  nodeId(): string | null {
    const value = this.get(META_KEYS.nodeId);
    if (value !== null && !isValidNodeId(value)) {
      throw new CorruptStoreError(`stored node id ${JSON.stringify(value)} is invalid`);
    }
    return value;
  }

  setNodeId(nodeId: string): void {
    if (!isValidNodeId(nodeId)) throw new RangeError(`invalid node id ${JSON.stringify(nodeId)}`);
    this.set(META_KEYS.nodeId, nodeId);
  }
}
