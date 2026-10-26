import { parseArgs } from "node:util";
import { formatMinor } from "../domain/money.js";
import * as accounts from "../repositories/accounts.js";
import * as entries from "../repositories/entries.js";
import * as transfers from "../repositories/transfers.js";
import { UsageError, runScript } from "./cli.js";

const USAGE = `usage: npm run show-transfer -- <transfer id>

Prints a transfer of any tenant with its entries and the names of both accounts, as JSON, for
support investigations. Exits 1 when no transfer has that id.`;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

await runScript(USAGE, async ({ pool }) => {
  let positionals: string[];
  try {
    ({ positionals } = parseArgs({ allowPositionals: true, options: {} }));
  } catch (err) {
    throw new UsageError((err as Error).message);
  }
  const [id] = positionals;
  if (positionals.length !== 1 || id === undefined || !UUID.test(id)) {
    throw new UsageError("give exactly one transfer id");
  }
  const found = await transfers.findTransferById(pool, id);
  if (!found) throw new Error(`no transfer ${id}`);
  const [from, to, legs] = await Promise.all([
    accounts.findAccountById(pool, found.fromAccountId),
    accounts.findAccountById(pool, found.toAccountId),
    entries.listEntriesForTransfer(pool, found.tenantId, found.id),
  ]);
  const view = {
    id: found.id,
    tenant_id: found.tenantId,
    created_at: found.createdAt.toISOString(),
    amount: formatMinor(found.amountMinor, found.currency),
    currency: found.currency,
    description: found.description,
    from: { id: found.fromAccountId, name: from?.name ?? null },
    to: { id: found.toAccountId, name: to?.name ?? null },
    entries: legs.map((leg) => ({
      account_id: leg.accountId,
      amount: formatMinor(leg.amountMinor, leg.currency),
      balance_after: formatMinor(leg.balanceAfter, leg.currency),
    })),
  };
  process.stdout.write(`${JSON.stringify(view, null, 2)}\n`);
});
