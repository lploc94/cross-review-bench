import type { Queryable } from "../db/pool.js";
import { toCurrencyCode, type CurrencyCode } from "../domain/currency.js";
import type { Hold, HoldStatus } from "../domain/hold.js";
import type { OffsetPage } from "../domain/pagination.js";
import { firstRow, requireRow, toBigInt } from "./mapping.js";

interface HoldRow {
  id: string;
  tenant_id: string;
  account_id: string;
  amount_minor: string;
  currency: string;
  status: HoldStatus;
  expires_at: Date;
  created_at: Date;
  updated_at: Date;
  captured_transfer_id: string | null;
}

const COLUMNS =
  "id, tenant_id, account_id, amount_minor, currency, status, expires_at, created_at, updated_at, captured_transfer_id";

function mapHold(row: HoldRow): Hold {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    accountId: row.account_id,
    amountMinor: toBigInt(row.amount_minor),
    currency: toCurrencyCode(row.currency),
    status: row.status,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    capturedTransferId: row.captured_transfer_id,
  };
}

export interface NewHold {
  readonly tenantId: string;
  readonly accountId: string;
  readonly amountMinor: bigint;
  readonly currency: CurrencyCode;
  readonly expiresAt: Date;
  readonly createdAt: Date;
}

export async function insertHold(db: Queryable, hold: NewHold): Promise<Hold> {
  const result = await db.query<HoldRow>(
    `INSERT INTO holds (tenant_id, account_id, amount_minor, currency, expires_at, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $6)
     RETURNING ${COLUMNS}`,
    [hold.tenantId, hold.accountId, hold.amountMinor, hold.currency, hold.expiresAt, hold.createdAt],
  );
  return mapHold(requireRow(result.rows, "insertHold"));
}

export async function findHold(db: Queryable, tenantId: string, id: string): Promise<Hold | null> {
  const result = await db.query<HoldRow>(
    `SELECT ${COLUMNS} FROM holds WHERE tenant_id = $1 AND id = $2`,
    [tenantId, id],
  );
  const row = firstRow(result.rows);
  return row ? mapHold(row) : null;
}

/**
 * Move an active, unexpired hold to `captured`. The condition is checked by the UPDATE itself,
 * so of two concurrent captures (or a capture racing a void) exactly one wins; null means the
 * hold was not active or had expired at `now`.
 */
export async function markHoldCaptured(
  db: Queryable,
  tenantId: string,
  id: string,
  now: Date,
): Promise<Hold | null> {
  const result = await db.query<HoldRow>(
    `UPDATE holds SET status = 'captured', updated_at = $3
     WHERE tenant_id = $1 AND id = $2 AND status = 'active' AND expires_at > $3
     RETURNING ${COLUMNS}`,
    [tenantId, id, now],
  );
  const row = firstRow(result.rows);
  return row ? mapHold(row) : null;
}

export async function setCapturedTransfer(
  db: Queryable,
  tenantId: string,
  id: string,
  transferId: string,
): Promise<Hold> {
  const result = await db.query<HoldRow>(
    `UPDATE holds SET captured_transfer_id = $3
     WHERE tenant_id = $1 AND id = $2 AND status = 'captured'
     RETURNING ${COLUMNS}`,
    [tenantId, id, transferId],
  );
  return mapHold(requireRow(result.rows, "setCapturedTransfer"));
}

/**
 * Move an active hold to `voided`, expired or not: voiding is how the reserved amount of an
 * expired hold is released. Null means the hold was no longer active.
 */
export async function markHoldVoided(
  db: Queryable,
  tenantId: string,
  id: string,
  now: Date,
): Promise<Hold | null> {
  const result = await db.query<HoldRow>(
    `UPDATE holds SET status = 'voided', updated_at = $3
     WHERE tenant_id = $1 AND id = $2 AND status = 'active'
     RETURNING ${COLUMNS}`,
    [tenantId, id, now],
  );
  const row = firstRow(result.rows);
  return row ? mapHold(row) : null;
}

export interface HoldFilter {
  readonly accountId?: string | undefined;
  readonly status?: HoldStatus | undefined;
  /** Inclusive lower bound on created_at. */
  readonly createdFrom?: Date | undefined;
  /** Exclusive upper bound on created_at. */
  readonly createdTo?: Date | undefined;
}

/** Newest first; one row more than the page so the caller can tell whether another page exists. */
export async function listHolds(
  db: Queryable,
  tenantId: string,
  filter: HoldFilter,
  page: OffsetPage,
): Promise<Hold[]> {
  const params: unknown[] = [tenantId];
  const conditions = ["tenant_id = $1"];
  if (filter.accountId !== undefined) {
    params.push(filter.accountId);
    conditions.push(`account_id = $${params.length}`);
  }
  if (filter.status !== undefined) {
    params.push(filter.status);
    conditions.push(`status = $${params.length}`);
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
  const result = await db.query<HoldRow>(
    `SELECT ${COLUMNS} FROM holds
     WHERE ${conditions.join(" AND ")}
     ORDER BY created_at DESC, id DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
  return result.rows.map(mapHold);
}
