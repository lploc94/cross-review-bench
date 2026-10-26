import type { CurrencyCode } from "./currency.js";
import {
  AccountClosedError,
  ConflictError,
  CurrencyMismatchError,
  InsufficientFundsError,
} from "./errors.js";

export const ACCOUNT_KINDS = ["wallet", "system"] as const;
export type AccountKind = (typeof ACCOUNT_KINDS)[number];

export const ACCOUNT_STATUSES = ["open", "closed"] as const;
export type AccountStatus = (typeof ACCOUNT_STATUSES)[number];

export interface Account {
  readonly id: string;
  readonly tenantId: string;
  readonly name: string;
  readonly currency: CurrencyCode;
  readonly kind: AccountKind;
  readonly status: AccountStatus;
  readonly balanceMinor: bigint;
  readonly heldMinor: bigint;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** Funds the owner can move: the balance minus what active holds reserve. */
export function availableBalance(account: Pick<Account, "balanceMinor" | "heldMinor">): bigint {
  return account.balanceMinor - account.heldMinor;
}

/** System accounts (funding, settlement) may go below zero; wallets may not. */
export function mayOverdraw(account: Pick<Account, "kind">): boolean {
  return account.kind === "system";
}

export function assertOpen(account: Pick<Account, "id" | "status">): void {
  if (account.status !== "open") {
    throw new AccountClosedError(account.id);
  }
}

export function assertCurrency(account: Pick<Account, "id" | "currency">, currency: CurrencyCode): void {
  if (account.currency !== currency) {
    throw new CurrencyMismatchError(account.currency, currency, { account_id: account.id });
  }
}

/** Throw unless `amountMinor` can leave the account without breaking the no-overdraft rule. */
export function assertCanDebit(account: Account, amountMinor: bigint): void {
  if (mayOverdraw(account)) return;
  const available = availableBalance(account);
  if (available < amountMinor) {
    throw new InsufficientFundsError(account.id, available, amountMinor);
  }
}

/** An account can be closed only when nothing is left on it and nothing is reserved. */
export function assertClosable(account: Account): void {
  if (account.balanceMinor !== 0n || account.heldMinor !== 0n) {
    throw new ConflictError(`account ${account.id} still has a balance or active holds`, {
      account_id: account.id,
      balance: account.balanceMinor.toString(),
      held: account.heldMinor.toString(),
    });
  }
}
