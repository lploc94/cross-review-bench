import type { Queryable } from "../db/pool.js";
import { toCurrencyCode, type CurrencyCode } from "../domain/currency.js";
import type { OffsetPage } from "../domain/pagination.js";
import type { Metadata, Transfer, TransferStatus } from "../domain/transfer.js";
import { firstRow, requireRow, toBigInt } from "./mapping.js";

interface TransferRow {
  id: string;
  tenant_id: string;
  from_account_id: string;
  to_account_id: string;
  amount_minor: string;
  currency: string;
  description: string | null;
  metadata: Record<string, string>;
  status: TransferStatus;
  created_at: Date;
}

const COLUMNS =
  "id, tenant_id, from_account_id, to_account_id, amount_minor, currency, description, metadata, status, created_at";

function mapTransfer(row: TransferRow): Transfer {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    fromAccountId: row.from_account_id,
    toAccountId: row.to_account_id,
    amountMinor: toBigInt(row.amount_minor),
    currency: toCurrencyCode(row.currency),
    description: row.description,
    metadata: row.metadata,
    status: row.status,
    createdAt: row.created_at,
  };
}

export interface NewTransfer {
  readonly tenantId: string;
  readonly fromAccountId: string;
  readonly toAccountId: string;
  readonly amountMinor: bigint;
  readonly currency: CurrencyCode;
  readonly description: string | null;
  readonly metadata: Metadata;
  readonly createdAt: Date;
}

export async function insertTransfer(db: Queryable, transfer: NewTransfer): Promise<Transfer> {
  const result = await db.query<TransferRow>(
    `INSERT INTO transfers
       (tenant_id, from_account_id, to_account_id, amount_minor, currency, description, metadata, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)
     RETURNING ${COLUMNS}`,
    [
      transfer.tenantId,
      transfer.fromAccountId,
      transfer.toAccountId,
      transfer.amountMinor,
      transfer.currency,
      transfer.description,
      JSON.stringify(transfer.metadata),
      transfer.createdAt,
    ],
  );
  return mapTransfer(requireRow(result.rows, "insertTransfer"));
}

export async function findTransfer(
  db: Queryable,
  tenantId: string,
  id: string,
): Promise<Transfer | null> {
  const result = await db.query<TransferRow>(
    `SELECT ${COLUMNS} FROM transfers WHERE tenant_id = $1 AND id = $2`,
    [tenantId, id],
  );
  const row = firstRow(result.rows);
  return row ? mapTransfer(row) : null;
}

/** A transfer of any tenant, for operator tooling that works across tenants (`show-transfer`). */
export async function findTransferById(db: Queryable, id: string): Promise<Transfer | null> {
  const result = await db.query<TransferRow>(`SELECT ${COLUMNS} FROM transfers WHERE id = $1`, [id]);
  const row = firstRow(result.rows);
  return row ? mapTransfer(row) : null;
}

export interface TransferFilter {
  /** Transfers where this account is either the source or the destination. */
  readonly accountId?: string | undefined;
  /** Inclusive lower bound on created_at. */
  readonly createdFrom?: Date | undefined;
  /** Exclusive upper bound on created_at. */
  readonly createdTo?: Date | undefined;
}

/** Newest first; one row more than the page so the caller can tell whether another page exists. */
export async function listTransfers(
  db: Queryable,
  tenantId: string,
  filter: TransferFilter,
  page: OffsetPage,
): Promise<Transfer[]> {
  const params: unknown[] = [tenantId];
  const conditions = ["tenant_id = $1"];
  if (filter.accountId !== undefined) {
    params.push(filter.accountId);
    conditions.push(`(from_account_id = $${params.length} OR to_account_id = $${params.length})`);
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
  const result = await db.query<TransferRow>(
    `SELECT ${COLUMNS} FROM transfers
     WHERE ${conditions.join(" AND ")}
     ORDER BY created_at DESC, id DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
  return result.rows.map(mapTransfer);
}
