import type { Pool } from "../db/pool.js";
import { withTransaction } from "../db/tx.js";
import { assertClosable, type Account, type AccountKind } from "../domain/account.js";
import type { CurrencyCode } from "../domain/currency.js";
import { NotFoundError } from "../domain/errors.js";
import { toPage, type OffsetPage, type Page } from "../domain/pagination.js";
import type { Clock } from "../infra/clock.js";
import * as accounts from "../repositories/accounts.js";

export interface OpenAccountInput {
  readonly name: string;
  readonly currency: CurrencyCode;
  readonly kind: AccountKind;
}

export class AccountService {
  private readonly pool: Pool;
  private readonly clock: Clock;

  constructor(deps: { pool: Pool; clock: Clock }) {
    this.pool = deps.pool;
    this.clock = deps.clock;
  }

  async openAccount(tenantId: string, input: OpenAccountInput): Promise<Account> {
    return accounts.insertAccount(this.pool, {
      tenantId,
      name: input.name,
      currency: input.currency,
      kind: input.kind,
      createdAt: this.clock.now(),
    });
  }

  async getAccount(tenantId: string, id: string): Promise<Account> {
    const account = await accounts.findAccount(this.pool, tenantId, id);
    if (!account) throw NotFoundError.resource("account", id);
    return account;
  }

  async listAccounts(tenantId: string, page: OffsetPage): Promise<Page<Account>> {
    const rows = await accounts.listAccounts(this.pool, tenantId, page);
    return toPage(rows, page);
  }

  /**
   * Close an account with nothing left on it. The row is locked first, so a transfer or hold
   * that commits in between is seen before the zero-balance check. Closing a closed account
   * returns it unchanged.
   */
  async closeAccount(tenantId: string, id: string): Promise<Account> {
    return withTransaction(this.pool, async (client) => {
      const account = await accounts.lockAccount(client, tenantId, id);
      if (!account) throw NotFoundError.resource("account", id);
      if (account.status === "closed") return account;
      assertClosable(account);
      return accounts.setAccountStatus(client, tenantId, id, "closed", this.clock.now());
    });
  }
}
