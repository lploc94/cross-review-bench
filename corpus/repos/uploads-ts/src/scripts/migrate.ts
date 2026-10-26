import { runMigrations } from "../db/migrate.js";
import { runScript } from "./cli.js";

const USAGE = "usage: npm run migrate";

await runScript(USAGE, async ({ pool, logger }) => {
  const applied = await runMigrations(pool, { logger });
  process.stdout.write(
    applied.length === 0 ? "database is up to date\n" : `applied ${applied.join(", ")}\n`,
  );
});
