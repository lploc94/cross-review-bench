import type { CurrencyCode } from "./currency.js";

export type TransferStatus = "posted";

export type Metadata = Readonly<Record<string, string>>;

export interface Transfer {
  readonly id: string;
  readonly tenantId: string;
  readonly fromAccountId: string;
  readonly toAccountId: string;
  readonly amountMinor: bigint;
  readonly currency: CurrencyCode;
  readonly description: string | null;
  readonly metadata: Metadata;
  readonly status: TransferStatus;
  readonly createdAt: Date;
}

/** One leg of a transfer: negative on the debited account, positive on the credited one. */
export interface Entry {
  readonly id: string;
  readonly tenantId: string;
  readonly transferId: string;
  readonly accountId: string;
  readonly amountMinor: bigint;
  readonly currency: CurrencyCode;
  readonly balanceAfter: bigint;
  readonly createdAt: Date;
}

export interface TransferInput {
  readonly fromAccountId: string;
  readonly toAccountId: string;
  readonly amountMinor: bigint;
  readonly currency: CurrencyCode;
  readonly description?: string | undefined;
  readonly metadata?: Metadata | undefined;
}

/** The sum of a transfer's entries; double-entry bookkeeping requires it to be zero. */
export function entriesTotal(entries: readonly Pick<Entry, "amountMinor">[]): bigint {
  return entries.reduce((sum, entry) => sum + entry.amountMinor, 0n);
}
