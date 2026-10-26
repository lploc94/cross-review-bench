import type { Pool } from "../db/pool.js";
import { withTransaction } from "../db/tx.js";
import { NotFoundError } from "../domain/errors.js";
import type { JsonValue } from "../domain/json.js";
import { toPage, type OffsetPage, type Page } from "../domain/pagination.js";
import type { Entry, Transfer, TransferInput } from "../domain/transfer.js";
import type { Clock } from "../infra/clock.js";
import * as accounts from "../repositories/accounts.js";
import * as entries from "../repositories/entries.js";
import * as transfers from "../repositories/transfers.js";
import type { TransferFilter } from "../repositories/transfers.js";
import { hashRequest, runIdempotent, type IdempotentResult } from "./idempotency.js";
import { postTransfer, type PostingResult } from "./ledgerPosting.js";

export interface CreateTransferRequest {
  readonly tenantId: string;
  readonly idempotencyKey: string;
  readonly input: TransferInput;
  /** Renders the HTTP body stored with the idempotency key and replayed on retries. */
  readonly present: (result: PostingResult) => JsonValue;
}

export interface TransferWithEntries {
  readonly transfer: Transfer;
  readonly entries: readonly Entry[];
}

/** The fields that make two transfer requests "the same request" for idempotency. */
function transferFingerprint(input: TransferInput): JsonValue {
  return {
    from_account_id: input.fromAccountId,
    to_account_id: input.toAccountId,
    amount: input.amountMinor.toString(),
    currency: input.currency,
    description: input.description ?? null,
    metadata: { ...(input.metadata ?? {}) },
  };
}

export class TransferService {
  private readonly pool: Pool;
  private readonly clock: Clock;

  constructor(deps: { pool: Pool; clock: Clock }) {
    this.pool = deps.pool;
    this.clock = deps.clock;
  }

  /**
   * Post a transfer exactly once per idempotency key. Both accounts are locked in ascending id
   * order before anything is checked, so concurrent transfers between the same accounts are
   * serialized and every balance check sees the latest committed balance.
   */
  async createTransfer(request: CreateTransferRequest): Promise<IdempotentResult> {
    const { tenantId, input } = request;
    const now = this.clock.now();
    const scope = {
      tenantId,
      key: request.idempotencyKey,
      requestHash: hashRequest("POST /transfers", transferFingerprint(input)),
    };
    return withTransaction(this.pool, (client) =>
      runIdempotent(client, scope, now, async () => {
        const locked = await accounts.lockAccounts(client, tenantId, [
          input.fromAccountId,
          input.toAccountId,
        ]);
        const from = locked.get(input.fromAccountId.toLowerCase());
        if (!from) throw NotFoundError.resource("account", input.fromAccountId);
        const to = locked.get(input.toAccountId.toLowerCase());
        if (!to) throw NotFoundError.resource("account", input.toAccountId);

        const result = await postTransfer(client, {
          tenantId,
          from,
          to,
          amountMinor: input.amountMinor,
          currency: input.currency,
          description: input.description ?? null,
          metadata: input.metadata ?? {},
          now,
        });
        return { status: 201, body: request.present(result) };
      }),
    );
  }

  async getTransfer(tenantId: string, id: string): Promise<TransferWithEntries> {
    const transfer = await transfers.findTransfer(this.pool, tenantId, id);
    if (!transfer) throw NotFoundError.resource("transfer", id);
    const legs = await entries.listEntriesForTransfer(this.pool, tenantId, id);
    return { transfer, entries: legs };
  }

  async listTransfers(
    tenantId: string,
    filter: TransferFilter,
    page: OffsetPage,
  ): Promise<Page<Transfer>> {
    const rows = await transfers.listTransfers(this.pool, tenantId, filter, page);
    return toPage(rows, page);
  }

  /** An account's ledger entries, newest first. */
  async listAccountEntries(
    tenantId: string,
    accountId: string,
    page: OffsetPage,
  ): Promise<Page<Entry>> {
    const account = await accounts.findAccount(this.pool, tenantId, accountId);
    if (!account) throw NotFoundError.resource("account", accountId);
    const rows = await entries.listEntriesForAccount(this.pool, tenantId, accountId, page);
    return toPage(rows, page);
  }
}
