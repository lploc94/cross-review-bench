import type { Queryable } from "../db/pool.js";
import { assertCanDebit, assertCurrency, assertOpen, type Account } from "../domain/account.js";
import type { CurrencyCode } from "../domain/currency.js";
import { ValidationError } from "../domain/errors.js";
import { transferPosted } from "../domain/events.js";
import { MAX_AMOUNT_MINOR } from "../domain/money.js";
import { entriesTotal, type Entry, type Metadata, type Transfer } from "../domain/transfer.js";
import * as accounts from "../repositories/accounts.js";
import * as entries from "../repositories/entries.js";
import * as outbox from "../repositories/outbox.js";
import * as transfers from "../repositories/transfers.js";

export interface PostingInput {
  readonly tenantId: string;
  /** Source account, already locked by the caller's transaction. */
  readonly from: Account;
  /** Destination account, already locked by the caller's transaction. */
  readonly to: Account;
  readonly amountMinor: bigint;
  readonly currency: CurrencyCode;
  readonly description: string | null;
  readonly metadata: Metadata;
  readonly now: Date;
}

export interface PostingResult {
  readonly transfer: Transfer;
  readonly entries: readonly Entry[];
  readonly from: Account;
  readonly to: Account;
}

/**
 * Post a transfer between two locked accounts: check both are open and in the transfer's
 * currency and that the source can pay, then write the transfer, its two entries (a negative
 * debit and a positive credit that sum to zero, each with the balance it leaves), the balance
 * updates and the `transfer.posted` outbox event. All of it runs in the caller's transaction and
 * shares one timestamp.
 */
export async function postTransfer(db: Queryable, input: PostingInput): Promise<PostingResult> {
  const { from, to, amountMinor, currency, now, tenantId } = input;
  if (from.id === to.id) {
    throw new ValidationError("source and destination accounts must differ");
  }
  if (amountMinor <= 0n || amountMinor > MAX_AMOUNT_MINOR) {
    throw new ValidationError(`amount must be between 1 and ${MAX_AMOUNT_MINOR}`);
  }
  assertOpen(from);
  assertOpen(to);
  assertCurrency(from, currency);
  assertCurrency(to, currency);
  assertCanDebit(from, amountMinor);

  const transfer = await transfers.insertTransfer(db, {
    tenantId,
    fromAccountId: from.id,
    toAccountId: to.id,
    amountMinor,
    currency,
    description: input.description,
    metadata: input.metadata,
    createdAt: now,
  });
  const debited = await accounts.applyBalanceChange(db, tenantId, from.id, {
    balanceDelta: -amountMinor,
    heldDelta: 0n,
    updatedAt: now,
  });
  const credited = await accounts.applyBalanceChange(db, tenantId, to.id, {
    balanceDelta: amountMinor,
    heldDelta: 0n,
    updatedAt: now,
  });
  const legs = await entries.insertEntries(db, [
    {
      tenantId,
      transferId: transfer.id,
      accountId: from.id,
      amountMinor: -amountMinor,
      currency,
      balanceAfter: debited.balanceMinor,
      createdAt: now,
    },
    {
      tenantId,
      transferId: transfer.id,
      accountId: to.id,
      amountMinor,
      currency,
      balanceAfter: credited.balanceMinor,
      createdAt: now,
    },
  ]);
  if (entriesTotal(legs) !== 0n) {
    // Unreachable unless the code above is changed; refuse to commit an unbalanced transfer.
    throw new Error(`transfer ${transfer.id} entries do not sum to zero`);
  }
  await outbox.insertEvent(db, transferPosted(transfer), now);
  return { transfer, entries: legs, from: debited, to: credited };
}
