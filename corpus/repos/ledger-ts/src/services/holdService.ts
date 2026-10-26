import type { Pool, PoolClient } from "../db/pool.js";
import { withTransaction } from "../db/tx.js";
import { assertCanDebit, assertCurrency, assertOpen } from "../domain/account.js";
import type { CurrencyCode } from "../domain/currency.js";
import { NotFoundError, ValidationError } from "../domain/errors.js";
import { holdCaptured, holdCreated, holdVoided } from "../domain/events.js";
import {
  MAX_HOLD_SECONDS,
  MIN_HOLD_SECONDS,
  holdExpiry,
  holdStateError,
  type Hold,
} from "../domain/hold.js";
import { MAX_AMOUNT_MINOR } from "../domain/money.js";
import { toPage, type OffsetPage, type Page } from "../domain/pagination.js";
import type { Transfer } from "../domain/transfer.js";
import type { Clock } from "../infra/clock.js";
import * as accounts from "../repositories/accounts.js";
import * as holds from "../repositories/holds.js";
import type { HoldFilter } from "../repositories/holds.js";
import * as outbox from "../repositories/outbox.js";
import { postTransfer } from "./ledgerPosting.js";

export interface CreateHoldInput {
  readonly accountId: string;
  readonly amountMinor: bigint;
  readonly currency: CurrencyCode;
  readonly expiresInSeconds: number;
}

export interface CaptureResult {
  readonly hold: Hold;
  readonly transfer: Transfer;
}

/**
 * Holds reserve funds on an account for later capture. Lock order is always account rows first
 * (ascending id), then the hold row, in every operation here, so capture and void racing on the
 * same hold cannot deadlock; the conditional UPDATEs on the hold decide which one wins.
 */
export class HoldService {
  private readonly pool: Pool;
  private readonly clock: Clock;

  constructor(deps: { pool: Pool; clock: Clock }) {
    this.pool = deps.pool;
    this.clock = deps.clock;
  }

  async createHold(tenantId: string, input: CreateHoldInput): Promise<Hold> {
    if (
      !Number.isInteger(input.expiresInSeconds) ||
      input.expiresInSeconds < MIN_HOLD_SECONDS ||
      input.expiresInSeconds > MAX_HOLD_SECONDS
    ) {
      throw new ValidationError(
        `expires_in_seconds must be between ${MIN_HOLD_SECONDS} and ${MAX_HOLD_SECONDS}`,
      );
    }
    if (input.amountMinor <= 0n || input.amountMinor > MAX_AMOUNT_MINOR) {
      throw new ValidationError(`amount must be between 1 and ${MAX_AMOUNT_MINOR}`);
    }
    const now = this.clock.now();
    return withTransaction(this.pool, async (client) => {
      const account = await accounts.lockAccount(client, tenantId, input.accountId);
      if (!account) throw NotFoundError.resource("account", input.accountId);
      assertOpen(account);
      assertCurrency(account, input.currency);
      assertCanDebit(account, input.amountMinor);

      const hold = await holds.insertHold(client, {
        tenantId,
        accountId: account.id,
        amountMinor: input.amountMinor,
        currency: input.currency,
        expiresAt: holdExpiry(now, input.expiresInSeconds),
        createdAt: now,
      });
      await accounts.applyBalanceChange(client, tenantId, account.id, {
        balanceDelta: 0n,
        heldDelta: input.amountMinor,
        updatedAt: now,
      });
      await outbox.insertEvent(client, holdCreated(hold), now);
      return hold;
    });
  }

  async getHold(tenantId: string, id: string): Promise<Hold> {
    const hold = await holds.findHold(this.pool, tenantId, id);
    if (!hold) throw NotFoundError.resource("hold", id);
    return hold;
  }

  async listHolds(tenantId: string, filter: HoldFilter, page: OffsetPage): Promise<Page<Hold>> {
    const rows = await holds.listHolds(this.pool, tenantId, filter, page);
    return toPage(rows, page);
  }

  /**
   * Capture the full amount of an active hold into `toAccountId`: release the reservation on the
   * held account and post a transfer of the same amount to the destination, in one transaction.
   * A hold can be captured while now < expires_at.
   */
  async captureHold(tenantId: string, holdId: string, toAccountId: string): Promise<CaptureResult> {
    const now = this.clock.now();
    return withTransaction(this.pool, async (client) => {
      const hold = await this.findOrThrow(client, tenantId, holdId);
      if (hold.accountId === toAccountId.toLowerCase()) {
        throw new ValidationError("a hold cannot be captured into the account it is held on");
      }
      const locked = await accounts.lockAccounts(client, tenantId, [hold.accountId, toAccountId]);
      const destination = locked.get(toAccountId.toLowerCase());
      if (!destination) throw NotFoundError.resource("account", toAccountId);
      const source = locked.get(hold.accountId);
      if (!source) throw NotFoundError.resource("account", hold.accountId);

      const captured = await holds.markHoldCaptured(client, tenantId, holdId, now);
      if (!captured) {
        throw holdStateError(await this.findOrThrow(client, tenantId, holdId), "capture", now);
      }
      const released = await accounts.applyBalanceChange(client, tenantId, source.id, {
        balanceDelta: 0n,
        heldDelta: -captured.amountMinor,
        updatedAt: now,
      });
      const posting = await postTransfer(client, {
        tenantId,
        from: released,
        to: destination,
        amountMinor: captured.amountMinor,
        currency: captured.currency,
        description: `Capture of hold ${captured.id}`,
        metadata: { hold_id: captured.id },
        now,
      });
      const settled = await holds.setCapturedTransfer(
        client,
        tenantId,
        captured.id,
        posting.transfer.id,
      );
      await outbox.insertEvent(client, holdCaptured(settled, posting.transfer), now);
      return { hold: settled, transfer: posting.transfer };
    });
  }

  /**
   * Void an active hold and release its reservation. Expired holds that were never captured are
   * still active and are voided the same way, which is how their funds become available again.
   */
  async voidHold(tenantId: string, holdId: string): Promise<Hold> {
    const now = this.clock.now();
    return withTransaction(this.pool, async (client) => {
      const hold = await this.findOrThrow(client, tenantId, holdId);
      const account = await accounts.lockAccount(client, tenantId, hold.accountId);
      if (!account) throw NotFoundError.resource("account", hold.accountId);

      const voided = await holds.markHoldVoided(client, tenantId, holdId, now);
      if (!voided) {
        throw holdStateError(await this.findOrThrow(client, tenantId, holdId), "void", now);
      }
      await accounts.applyBalanceChange(client, tenantId, account.id, {
        balanceDelta: 0n,
        heldDelta: -voided.amountMinor,
        updatedAt: now,
      });
      await outbox.insertEvent(client, holdVoided(voided), now);
      return voided;
    });
  }

  private async findOrThrow(client: PoolClient, tenantId: string, id: string): Promise<Hold> {
    const hold = await holds.findHold(client, tenantId, id);
    if (!hold) throw NotFoundError.resource("hold", id);
    return hold;
  }
}
