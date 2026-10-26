import type { Queryable } from "../db/pool.js";
import { toBigInt } from "./mapping.js";

/*
 * Read-only consistency queries over the whole ledger of one tenant. Each returns the rows that
 * break one invariant; a healthy ledger returns nothing from any of them.
 */

export interface UnbalancedTransferRow {
  readonly transferId: string;
  readonly entryCount: number;
  readonly total: bigint;
}

/** Transfers whose entries do not sum to zero, or that do not have exactly two entries. */
export async function findUnbalancedTransfers(
  db: Queryable,
  tenantId: string,
): Promise<UnbalancedTransferRow[]> {
  const result = await db.query<{ transfer_id: string; entry_count: string; total: string }>(
    `SELECT t.id AS transfer_id,
            count(e.id) AS entry_count,
            coalesce(sum(e.amount_minor), 0) AS total
     FROM transfers t
     LEFT JOIN entries e ON e.tenant_id = t.tenant_id AND e.transfer_id = t.id
     WHERE t.tenant_id = $1
     GROUP BY t.id
     HAVING count(e.id) <> 2 OR coalesce(sum(e.amount_minor), 0) <> 0
     ORDER BY t.id`,
    [tenantId],
  );
  return result.rows.map((row) => ({
    transferId: row.transfer_id,
    entryCount: Number(row.entry_count),
    total: toBigInt(row.total),
  }));
}

export interface BalanceMismatchRow {
  readonly accountId: string;
  readonly recorded: bigint;
  readonly expected: bigint;
}

/** Accounts whose balance differs from the sum of their entries. */
export async function findBalanceMismatches(
  db: Queryable,
  tenantId: string,
): Promise<BalanceMismatchRow[]> {
  const result = await db.query<{ account_id: string; recorded: string; expected: string }>(
    `SELECT a.id AS account_id,
            a.balance_minor AS recorded,
            coalesce(sum(e.amount_minor), 0) AS expected
     FROM accounts a
     LEFT JOIN entries e ON e.tenant_id = a.tenant_id AND e.account_id = a.id
     WHERE a.tenant_id = $1
     GROUP BY a.id, a.balance_minor
     HAVING a.balance_minor <> coalesce(sum(e.amount_minor), 0)
     ORDER BY a.id`,
    [tenantId],
  );
  return result.rows.map((row) => ({
    accountId: row.account_id,
    recorded: toBigInt(row.recorded),
    expected: toBigInt(row.expected),
  }));
}

/** Accounts whose held amount differs from the sum of their active holds. */
export async function findHeldMismatches(
  db: Queryable,
  tenantId: string,
): Promise<BalanceMismatchRow[]> {
  const result = await db.query<{ account_id: string; recorded: string; expected: string }>(
    `SELECT a.id AS account_id,
            a.held_minor AS recorded,
            coalesce(sum(h.amount_minor) FILTER (WHERE h.status = 'active'), 0) AS expected
     FROM accounts a
     LEFT JOIN holds h ON h.tenant_id = a.tenant_id AND h.account_id = a.id
     WHERE a.tenant_id = $1
     GROUP BY a.id, a.held_minor
     HAVING a.held_minor <> coalesce(sum(h.amount_minor) FILTER (WHERE h.status = 'active'), 0)
     ORDER BY a.id`,
    [tenantId],
  );
  return result.rows.map((row) => ({
    accountId: row.account_id,
    recorded: toBigInt(row.recorded),
    expected: toBigInt(row.expected),
  }));
}

/** Captured holds that do not point at a transfer of their amount out of their account. */
export async function findUnsettledCaptures(db: Queryable, tenantId: string): Promise<string[]> {
  const result = await db.query<{ id: string }>(
    `SELECT h.id
     FROM holds h
     LEFT JOIN transfers t ON t.tenant_id = h.tenant_id AND t.id = h.captured_transfer_id
     WHERE h.tenant_id = $1
       AND h.status = 'captured'
       AND (t.id IS NULL OR t.from_account_id <> h.account_id OR t.amount_minor <> h.amount_minor)
     ORDER BY h.id`,
    [tenantId],
  );
  return result.rows.map((row) => row.id);
}
