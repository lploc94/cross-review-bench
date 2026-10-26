import { runMigrations } from "../db/migrate.js";
import { runScript } from "./cli.js";

const USAGE = "usage: npm run migrate";

await runScript(USAGE, async ({ pool, logger }) => {
  const applied = await runMigrations(pool, { logger });
  logger.info({ applied }, applied.length ? "migrations applied" : "database is up to date");
});
