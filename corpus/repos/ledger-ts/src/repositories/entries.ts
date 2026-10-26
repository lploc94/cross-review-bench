import type { Queryable } from "../db/pool.js";
import { toCurrencyCode, type CurrencyCode } from "../domain/currency.js";
import type { OffsetPage } from "../domain/pagination.js";
import type { Entry } from "../domain/transfer.js";
import { toBigInt } from "./mapping.js";

interface EntryRow {
  id: string;
  tenant_id: string;
  transfer_id: string;
  account_id: string;
  amount_minor: string;
  currency: string;
  balance_after: string;
  created_at: Date;
}

const COLUMNS =
  "id, tenant_id, transfer_id, account_id, amount_minor, currency, balance_after, created_at";

function mapEntry(row: EntryRow): Entry {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    transferId: row.transfer_id,
    accountId: row.account_id,
    amountMinor: toBigInt(row.amount_minor),
    currency: toCurrencyCode(row.currency),
    balanceAfter: toBigInt(row.balance_after),
    createdAt: row.created_at,
  };
}

export interface NewEntry {
  readonly tenantId: string;
  readonly transferId: string;
  readonly accountId: string;
  readonly amountMinor: bigint;
  readonly currency: CurrencyCode;
  readonly balanceAfter: bigint;
  readonly createdAt: Date;
}

/** Insert the legs of one transfer in a single statement, in the order given. */
export async function insertEntries(db: Queryable, entries: readonly NewEntry[]): Promise<Entry[]> {
  if (entries.length === 0) return [];
  const params: unknown[] = [];
  const tuples = entries.map((entry) => {
    params.push(
      entry.tenantId,
      entry.transferId,
      entry.accountId,
      entry.amountMinor,
      entry.currency,
      entry.balanceAfter,
      entry.createdAt,
    );
    const base = params.length - 7;
    return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7})`;
  });
  const result = await db.query<EntryRow>(
    `INSERT INTO entries
       (tenant_id, transfer_id, account_id, amount_minor, currency, balance_after, created_at)
     VALUES ${tuples.join(", ")}
     RETURNING ${COLUMNS}`,
    params,
  );
  return result.rows.map(mapEntry);
}

/**
 * An account's entries, newest first. The entries of one transfer share created_at (they are
 * written with one timestamp in one transaction), so id breaks the tie and keeps pages stable.
 */
export async function listEntriesForAccount(
  db: Queryable,
  tenantId: string,
  accountId: string,
  page: OffsetPage,
): Promise<Entry[]> {
  const result = await db.query<EntryRow>(
    `SELECT ${COLUMNS} FROM entries
     WHERE tenant_id = $1 AND account_id = $2
     ORDER BY created_at DESC, id DESC
     LIMIT $3 OFFSET $4`,
    [tenantId, accountId, page.limit + 1, page.offset],
  );
  return result.rows.map(mapEntry);
}

/** The legs of one transfer: the debit first, then the credit. */
export async function listEntriesForTransfer(
  db: Queryable,
  tenantId: string,
  transferId: string,
): Promise<Entry[]> {
  const result = await db.query<EntryRow>(
    `SELECT ${COLUMNS} FROM entries
     WHERE tenant_id = $1 AND transfer_id = $2
     ORDER BY amount_minor ASC, id ASC`,
    [tenantId, transferId],
  );
  return result.rows.map(mapEntry);
}
