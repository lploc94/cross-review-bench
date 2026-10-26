import type { Pool } from "../db/pool.js";
import { withTransaction } from "../db/tx.js";
import * as checks from "../repositories/ledgerChecks.js";

export type LedgerProblem =
  | { readonly kind: "unbalanced_transfer"; readonly transferId: string; readonly entryCount: number; readonly total: bigint }
  | { readonly kind: "balance_mismatch"; readonly accountId: string; readonly recorded: bigint; readonly expected: bigint }
  | { readonly kind: "held_mismatch"; readonly accountId: string; readonly recorded: bigint; readonly expected: bigint }
  | { readonly kind: "unsettled_capture"; readonly holdId: string };

export interface LedgerReport {
  readonly tenantId: string;
  readonly problems: readonly LedgerProblem[];
}

/**
 * Checks the ledger's invariants for a tenant: every transfer has two entries that sum to zero,
 * every balance is the sum of the account's entries, every held amount is the sum of the
 * account's active holds, and every captured hold points at its transfer.
 *
 * The queries run in one REPEATABLE READ READ ONLY transaction, so they all see the same
 * snapshot and a transfer committing in between cannot show up as a false mismatch.
 */
export class LedgerVerifier {
  private readonly pool: Pool;

  constructor(deps: { pool: Pool }) {
    this.pool = deps.pool;
  }

  async verifyTenant(tenantId: string): Promise<LedgerReport> {
    return withTransaction(
      this.pool,
      async (client) => {
        await client.query("SET TRANSACTION READ ONLY");
        const problems: LedgerProblem[] = [];
        for (const row of await checks.findUnbalancedTransfers(client, tenantId)) {
          problems.push({ kind: "unbalanced_transfer", ...row });
        }
        for (const row of await checks.findBalanceMismatches(client, tenantId)) {
          problems.push({ kind: "balance_mismatch", ...row });
        }
        for (const row of await checks.findHeldMismatches(client, tenantId)) {
          problems.push({ kind: "held_mismatch", ...row });
        }
        for (const holdId of await checks.findUnsettledCaptures(client, tenantId)) {
          problems.push({ kind: "unsettled_capture", holdId });
        }
        return { tenantId, problems };
      },
      { isolation: "repeatable read" },
    );
  }

  /** Every tenant's report, in tenant id order. */
  async verifyAll(): Promise<LedgerReport[]> {
    const result = await this.pool.query<{ id: string }>("SELECT id FROM tenants ORDER BY id");
    const reports: LedgerReport[] = [];
    for (const { id } of result.rows) {
      reports.push(await this.verifyTenant(id));
    }
    return reports;
  }
}
