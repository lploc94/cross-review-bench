import type { Queryable } from "../db/pool.js";
import type { Account, AccountKind, AccountStatus } from "../domain/account.js";
import { toCurrencyCode, type CurrencyCode } from "../domain/currency.js";
import type { OffsetPage } from "../domain/pagination.js";
import { firstRow, requireRow, toBigInt } from "./mapping.js";

interface AccountRow {
  id: string;
  tenant_id: string;
  name: string;
  currency: string;
  kind: AccountKind;
  status: AccountStatus;
  balance_minor: string;
  held_minor: string;
  created_at: Date;
  updated_at: Date;
}

const COLUMNS =
  "id, tenant_id, name, currency, kind, status, balance_minor, held_minor, created_at, updated_at";

function mapAccount(row: AccountRow): Account {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    name: row.name,
    currency: toCurrencyCode(row.currency),
    kind: row.kind,
    status: row.status,
    balanceMinor: toBigInt(row.balance_minor),
    heldMinor: toBigInt(row.held_minor),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface NewAccount {
  readonly tenantId: string;
  readonly name: string;
  readonly currency: CurrencyCode;
  readonly kind: AccountKind;
  readonly createdAt: Date;
}

export async function insertAccount(db: Queryable, account: NewAccount): Promise<Account> {
  const result = await db.query<AccountRow>(
    `INSERT INTO accounts (tenant_id, name, currency, kind, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $5)
     RETURNING ${COLUMNS}`,
    [account.tenantId, account.name, account.currency, account.kind, account.createdAt],
  );
  return mapAccount(requireRow(result.rows, "insertAccount"));
}

export async function findAccount(
  db: Queryable,
  tenantId: string,
  id: string,
): Promise<Account | null> {
  const result = await db.query<AccountRow>(
    `SELECT ${COLUMNS} FROM accounts WHERE tenant_id = $1 AND id = $2`,
    [tenantId, id],
  );
  const row = firstRow(result.rows);
  return row ? mapAccount(row) : null;
}

/** An account of any tenant, for operator tooling that works across tenants (`show-transfer`). */
export async function findAccountById(db: Queryable, id: string): Promise<Account | null> {
  const result = await db.query<AccountRow>(`SELECT ${COLUMNS} FROM accounts WHERE id = $1`, [id]);
  const row = firstRow(result.rows);
  return row ? mapAccount(row) : null;
}

/**
 * Lock accounts for the rest of the transaction (`SELECT … FOR UPDATE`), one at a time in
 * ascending id order. Every code path that locks more than one account goes through here, so
 * two transactions touching the same pair always lock in the same order and cannot deadlock.
 * Ids the tenant does not own are missing from the result.
 */
export async function lockAccounts(
  db: Queryable,
  tenantId: string,
  ids: readonly string[],
): Promise<Map<string, Account>> {
  const ordered = [...new Set(ids.map((id) => id.toLowerCase()))].sort();
  const locked = new Map<string, Account>();
  for (const id of ordered) {
    const result = await db.query<AccountRow>(
      `SELECT ${COLUMNS} FROM accounts WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
      [tenantId, id],
    );
    const row = firstRow(result.rows);
    if (row) locked.set(row.id, mapAccount(row));
  }
  return locked;
}

export async function lockAccount(
  db: Queryable,
  tenantId: string,
  id: string,
): Promise<Account | null> {
  const locked = await lockAccounts(db, tenantId, [id]);
  return locked.get(id.toLowerCase()) ?? null;
}

/** Newest first; one row more than the page so the caller can tell whether another page exists. */
export async function listAccounts(
  db: Queryable,
  tenantId: string,
  page: OffsetPage,
): Promise<Account[]> {
  const result = await db.query<AccountRow>(
    `SELECT ${COLUMNS} FROM accounts
     WHERE tenant_id = $1
     ORDER BY created_at DESC, id DESC
     LIMIT $2 OFFSET $3`,
    [tenantId, page.limit + 1, page.offset],
  );
  return result.rows.map(mapAccount);
}

export interface BalanceChange {
  readonly balanceDelta: bigint;
  readonly heldDelta: bigint;
  readonly updatedAt: Date;
}

/** Apply deltas to a locked account's balance and held amount and return the new state. */
export async function applyBalanceChange(
  db: Queryable,
  tenantId: string,
  id: string,
  change: BalanceChange,
): Promise<Account> {
  const result = await db.query<AccountRow>(
    `UPDATE accounts
     SET balance_minor = balance_minor + $3,
         held_minor = held_minor + $4,
         updated_at = $5
     WHERE tenant_id = $1 AND id = $2
     RETURNING ${COLUMNS}`,
    [tenantId, id, change.balanceDelta, change.heldDelta, change.updatedAt],
  );
  return mapAccount(requireRow(result.rows, "applyBalanceChange"));
}

export async function setAccountStatus(
  db: Queryable,
  tenantId: string,
  id: string,
  status: AccountStatus,
  updatedAt: Date,
): Promise<Account> {
  const result = await db.query<AccountRow>(
    `UPDATE accounts SET status = $3, updated_at = $4
     WHERE tenant_id = $1 AND id = $2
     RETURNING ${COLUMNS}`,
    [tenantId, id, status, updatedAt],
  );
  return mapAccount(requireRow(result.rows, "setAccountStatus"));
}
