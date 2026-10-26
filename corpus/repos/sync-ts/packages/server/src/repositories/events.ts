import type { Queryable } from "../db/pool.js";
import { toSafeInteger } from "./mapping.js";

/** A field write that won last-writer-wins, about to become an event. */
export interface NewEvent {
  readonly mutationId: string;
  readonly collection: string;
  readonly docId: string;
  readonly field: string;
  readonly value: unknown;
  readonly hlc: string;
}

export interface InsertedEvent {
  readonly seq: number;
  readonly collection: string;
  readonly docId: string;
}

export interface StoredEvent {
  readonly seq: number;
  readonly deviceId: string;
  readonly mutationId: string;
  readonly collection: string;
  readonly docId: string;
  readonly field: string;
  readonly value: unknown;
  readonly hlc: string;
  readonly serverReceivedAt: Date;
}

/**
 * Append events in the given order (sequence numbers follow it) and return their sequence
 * numbers. Values are sent as JSON text: node-postgres would turn a JavaScript array into a
 * PostgreSQL array literal.
 */
export async function insertEvents(
  db: Queryable,
  userId: string,
  deviceId: string,
  events: readonly NewEvent[],
  receivedAt: Date,
): Promise<InsertedEvent[]> {
  if (events.length === 0) return [];
  const result = await db.query<{ seq: string; collection: string; doc_id: string }>(
    `INSERT INTO events (user_id, device_id, mutation_id, collection, doc_id, field, value, hlc, server_received_at)
     SELECT $1, $2, e.mutation_id, e.collection, e.doc_id, e.field, e.value::jsonb, e.hlc, $3
       FROM unnest($4::uuid[], $5::text[], $6::text[], $7::text[], $8::text[], $9::text[])
            WITH ORDINALITY AS e(mutation_id, collection, doc_id, field, value, hlc, ord)
      ORDER BY e.ord
     RETURNING seq, collection, doc_id`,
    [
      userId,
      deviceId,
      receivedAt,
      events.map((e) => e.mutationId),
      events.map((e) => e.collection),
      events.map((e) => e.docId),
      events.map((e) => e.field),
      events.map((e) => JSON.stringify(e.value)),
      events.map((e) => e.hlc),
    ],
  );
  return result.rows.map((row) => ({
    seq: toSafeInteger(row.seq, "events.seq"),
    collection: row.collection,
    docId: row.doc_id,
  }));
}

interface EventRow {
  seq: string;
  device_id: string;
  mutation_id: string;
  collection: string;
  doc_id: string;
  field: string;
  value: unknown;
  hlc: string;
  server_received_at: Date;
}

/** At most `limit` events of the user with `seq > after`, in seq order. */
export async function listEventsAfter(
  db: Queryable,
  userId: string,
  after: number,
  limit: number,
): Promise<StoredEvent[]> {
  const result = await db.query<EventRow>(
    `SELECT seq, device_id, mutation_id, collection, doc_id, field, value, hlc, server_received_at
       FROM events
      WHERE user_id = $1 AND seq > $2
      ORDER BY seq
      LIMIT $3`,
    [userId, after, limit],
  );
  return result.rows.map((row) => ({
    seq: toSafeInteger(row.seq, "events.seq"),
    deviceId: row.device_id,
    mutationId: row.mutation_id,
    collection: row.collection,
    docId: row.doc_id,
    field: row.field,
    value: row.value,
    hlc: row.hlc,
    serverReceivedAt: row.server_received_at,
  }));
}

/** The highest seq of the user's events, or 0 when there is none. */
export async function latestSeq(db: Queryable, userId: string): Promise<number> {
  const result = await db.query<{ seq: string | null }>(
    "SELECT max(seq) AS seq FROM events WHERE user_id = $1",
    [userId],
  );
  const seq = result.rows[0]?.seq ?? null;
  return seq === null ? 0 : toSafeInteger(seq, "events.seq");
}

export async function countEvents(db: Queryable, userId: string): Promise<number> {
  return countEventsAfter(db, userId, 0);
}

/**
 * The number of the user's events with `seq > after`. Sequence numbers are shared by all users,
 * so the difference of two of a user's seqs says nothing about how many events lie between them.
 */
export async function countEventsAfter(db: Queryable, userId: string, after: number): Promise<number> {
  const result = await db.query<{ count: string }>(
    "SELECT count(*) AS count FROM events WHERE user_id = $1 AND seq > $2",
    [userId, after],
  );
  return toSafeInteger(result.rows[0]?.count ?? 0, "count");
}
