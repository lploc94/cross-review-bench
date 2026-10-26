import type { Queryable } from "../db/pool.js";
import type { Device, DeviceWithCursor } from "../domain/accounts.js";
import { toNullableSafeInteger } from "./mapping.js";

interface DeviceRow {
  id: string;
  user_id: string;
  name: string;
  created_at: Date;
  last_seen_at: Date | null;
}

function toDevice(row: DeviceRow): Device {
  return {
    id: row.id,
    userId: row.user_id,
    name: row.name,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
  };
}

export interface DeviceCredentials {
  readonly id: string;
  readonly userId: string;
  readonly tokenHash: string;
}

export async function insertDevice(
  db: Queryable,
  device: Device & { readonly tokenHash: string },
): Promise<void> {
  await db.query(
    `INSERT INTO devices (id, user_id, token_hash, name, created_at, last_seen_at)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [device.id, device.userId, device.tokenHash, device.name, device.createdAt, device.lastSeenAt],
  );
}

/** What authentication needs to check a token for the device. */
export async function findDeviceCredentials(
  db: Queryable,
  id: string,
): Promise<DeviceCredentials | null> {
  const result = await db.query<{ id: string; user_id: string; token_hash: string }>(
    "SELECT id, user_id, token_hash FROM devices WHERE id = $1",
    [id],
  );
  const row = result.rows[0];
  return row ? { id: row.id, userId: row.user_id, tokenHash: row.token_hash } : null;
}

export async function findDevice(db: Queryable, id: string): Promise<Device | null> {
  const result = await db.query<DeviceRow>(
    "SELECT id, user_id, name, created_at, last_seen_at FROM devices WHERE id = $1",
    [id],
  );
  const row = result.rows[0];
  return row ? toDevice(row) : null;
}

export async function countDevices(db: Queryable, userId: string): Promise<number> {
  const result = await db.query<{ count: string }>(
    "SELECT count(*) AS count FROM devices WHERE user_id = $1",
    [userId],
  );
  return Number(result.rows[0]?.count ?? 0);
}

/** The user's devices, oldest first, with the cursor each last confirmed. */
export async function listDevicesWithCursors(
  db: Queryable,
  userId: string,
  limit: number,
): Promise<DeviceWithCursor[]> {
  const result = await db.query<DeviceRow & { last_pulled_seq: string | null }>(
    `SELECT d.id, d.user_id, d.name, d.created_at, d.last_seen_at, c.last_pulled_seq
       FROM devices d
       LEFT JOIN device_cursors c ON c.device_id = d.id
      WHERE d.user_id = $1
      ORDER BY d.created_at, d.id
      LIMIT $2`,
    [userId, limit],
  );
  return result.rows.map((row) => ({
    ...toDevice(row),
    lastPulledSeq: toNullableSafeInteger(row.last_pulled_seq, "last_pulled_seq"),
  }));
}

/**
 * Record that the device made a request at `now`. Skipped while the stored time is less than
 * `resolutionMs` old, so a busy device does not write its row on every request.
 */
export async function touchDevice(
  db: Queryable,
  id: string,
  now: Date,
  resolutionMs: number,
): Promise<void> {
  await db.query(
    `UPDATE devices SET last_seen_at = $2
      WHERE id = $1
        AND (last_seen_at IS NULL OR last_seen_at <= $2::timestamptz - make_interval(secs => $3::double precision / 1000))`,
    [id, now, resolutionMs],
  );
}
