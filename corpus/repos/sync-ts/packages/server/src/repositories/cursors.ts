import type { Queryable } from "../db/pool.js";
import { toSafeInteger } from "./mapping.js";

/** Record `seq` as the last position the device has confirmed. */
export async function recordCursor(
  db: Queryable,
  deviceId: string,
  seq: number,
  now: Date,
): Promise<void> {
  await db.query(
    `INSERT INTO device_cursors (device_id, last_pulled_seq, updated_at)
     VALUES ($1, $2, $3)
     ON CONFLICT (device_id) DO UPDATE
       SET last_pulled_seq = EXCLUDED.last_pulled_seq, updated_at = EXCLUDED.updated_at`,
    [deviceId, seq, now],
  );
}

/** The device's last confirmed seq, or null before its first pull. */
export async function findCursor(db: Queryable, deviceId: string): Promise<number | null> {
  const result = await db.query<{ last_pulled_seq: string }>(
    "SELECT last_pulled_seq FROM device_cursors WHERE device_id = $1",
    [deviceId],
  );
  const row = result.rows[0];
  return row ? toSafeInteger(row.last_pulled_seq, "device_cursors.last_pulled_seq") : null;
}
