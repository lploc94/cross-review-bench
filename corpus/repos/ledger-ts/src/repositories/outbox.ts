import type { Queryable } from "../db/pool.js";
import type { NewEvent, OutboxEvent } from "../domain/events.js";
import type { JsonObject } from "../domain/json.js";
import type { OffsetPage } from "../domain/pagination.js";
import { firstRow, requireRow } from "./mapping.js";

interface OutboxRow {
  id: string;
  tenant_id: string;
  aggregate_id: string;
  event_type: string;
  payload: JsonObject;
  created_at: Date;
  attempts: number;
  next_attempt_at: Date;
  delivered_at: Date | null;
  last_error: string | null;
}

const COLUMNS =
  "id, tenant_id, aggregate_id, event_type, payload, created_at, attempts, next_attempt_at, delivered_at, last_error";

function mapEvent(row: OutboxRow): OutboxEvent {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    aggregateId: row.aggregate_id,
    eventType: row.event_type,
    payload: row.payload,
    createdAt: row.created_at,
    attempts: row.attempts,
    nextAttemptAt: row.next_attempt_at,
    deliveredAt: row.delivered_at,
    lastError: row.last_error,
  };
}

/** Write an event in the caller's transaction; it becomes due immediately. */
export async function insertEvent(
  db: Queryable,
  event: NewEvent,
  createdAt: Date,
): Promise<OutboxEvent> {
  const result = await db.query<OutboxRow>(
    `INSERT INTO outbox (tenant_id, aggregate_id, event_type, payload, created_at, next_attempt_at)
     VALUES ($1, $2, $3, $4::jsonb, $5, $5)
     RETURNING ${COLUMNS}`,
    [event.tenantId, event.aggregateId, event.eventType, JSON.stringify(event.payload), createdAt],
  );
  return mapEvent(requireRow(result.rows, "insertEvent"));
}

/**
 * Lock up to `limit` due, undelivered events in id order, skipping rows another dispatcher holds.
 * An event is only eligible when no earlier event of the same aggregate is still undelivered:
 * that keeps per-aggregate delivery in creation order, and an event that keeps failing holds
 * back the later events of its aggregate (but no other aggregate's).
 */
export async function claimDueEvents(
  db: Queryable,
  now: Date,
  limit: number,
): Promise<OutboxEvent[]> {
  const result = await db.query<OutboxRow>(
    `SELECT ${COLUMNS} FROM outbox o
     WHERE o.delivered_at IS NULL
       AND o.next_attempt_at <= $1
       AND NOT EXISTS (
         SELECT 1 FROM outbox earlier
         WHERE earlier.tenant_id = o.tenant_id
           AND earlier.aggregate_id = o.aggregate_id
           AND earlier.delivered_at IS NULL
           AND earlier.id < o.id
       )
     ORDER BY o.id
     LIMIT $2
     FOR UPDATE SKIP LOCKED`,
    [now, limit],
  );
  return result.rows.map(mapEvent);
}

export async function markDelivered(db: Queryable, id: string, deliveredAt: Date): Promise<void> {
  await db.query(
    `UPDATE outbox SET delivered_at = $2, attempts = attempts + 1, last_error = NULL
     WHERE id = $1`,
    [id, deliveredAt],
  );
}

export async function markFailed(
  db: Queryable,
  id: string,
  failure: { attempts: number; nextAttemptAt: Date; error: string },
): Promise<void> {
  await db.query(
    `UPDATE outbox SET attempts = $2, next_attempt_at = $3, last_error = $4
     WHERE id = $1`,
    [id, failure.attempts, failure.nextAttemptAt, failure.error],
  );
}

export interface EventFilter {
  readonly eventType?: string | undefined;
  readonly aggregateId?: string | undefined;
  /** Inclusive lower bound on created_at. */
  readonly createdFrom?: Date | undefined;
  /** Exclusive upper bound on created_at. */
  readonly createdTo?: Date | undefined;
}

/** A tenant's events, newest first; one row more than the page for `has_more`. */
export async function listEvents(
  db: Queryable,
  tenantId: string,
  filter: EventFilter,
  page: OffsetPage,
): Promise<OutboxEvent[]> {
  const params: unknown[] = [tenantId];
  const conditions = ["tenant_id = $1"];
  if (filter.eventType !== undefined) {
    params.push(filter.eventType);
    conditions.push(`event_type = $${params.length}`);
  }
  if (filter.aggregateId !== undefined) {
    params.push(filter.aggregateId);
    conditions.push(`aggregate_id = $${params.length}`);
  }
  if (filter.createdFrom !== undefined) {
    params.push(filter.createdFrom);
    conditions.push(`created_at >= $${params.length}`);
  }
  if (filter.createdTo !== undefined) {
    params.push(filter.createdTo);
    conditions.push(`created_at < $${params.length}`);
  }
  params.push(page.limit + 1, page.offset);
  const result = await db.query<OutboxRow>(
    `SELECT ${COLUMNS} FROM outbox
     WHERE ${conditions.join(" AND ")}
     ORDER BY id DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
  return result.rows.map(mapEvent);
}

export async function findEvent(
  db: Queryable,
  tenantId: string,
  id: string,
): Promise<OutboxEvent | null> {
  const result = await db.query<OutboxRow>(
    `SELECT ${COLUMNS} FROM outbox WHERE tenant_id = $1 AND id = $2`,
    [tenantId, id],
  );
  const row = firstRow(result.rows);
  return row ? mapEvent(row) : null;
}
