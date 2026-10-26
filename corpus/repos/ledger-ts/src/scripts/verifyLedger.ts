import { parseArgs } from "node:util";
import { LedgerVerifier, type LedgerReport } from "../services/ledgerVerifier.js";
import { UsageError, runScript } from "./cli.js";

const USAGE = `usage: npm run verify-ledger -- [--tenant <tenant id>]

Checks the ledger invariants (balanced transfers, balances and held amounts that match the
entries and holds) for one tenant or all of them. Prints one JSON line per problem and exits 1
when there is any.`;

function printProblems(report: LedgerReport): number {
  for (const problem of report.problems) {
    process.stdout.write(
      `${JSON.stringify({ tenant_id: report.tenantId, ...problem }, (_key, value: unknown) =>
        typeof value === "bigint" ? value.toString() : value,
      )}\n`,
    );
  }
  return report.problems.length;
}

await runScript(USAGE, async ({ pool, logger }) => {
  let values;
  try {
    ({ values } = parseArgs({ options: { tenant: { type: "string" } } }));
  } catch (err) {
    throw new UsageError((err as Error).message);
  }
  const verifier = new LedgerVerifier({ pool });
  const reports = values.tenant ? [await verifier.verifyTenant(values.tenant)] : await verifier.verifyAll();
  const problems = reports.reduce((sum, report) => sum + printProblems(report), 0);
  logger.info({ tenants: reports.length, problems }, "ledger verified");
  if (problems > 0) process.exitCode = 1;
});
