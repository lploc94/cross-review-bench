import { ManualClock } from "@sync/shared";
import type { FastifyInstance } from "fastify";
import { buildApp, type AppDeps } from "../../src/app.js";
import { loadConfig, type Config } from "../../src/config/env.js";
import type { Pool } from "../../src/db/pool.js";
import { createLogger } from "../../src/infra/logger.js";
import { AccountService } from "../../src/services/accountService.js";
import { testPool } from "./db.js";
import { testDatabaseUrl } from "./env.js";

export interface TestApp {
  readonly app: FastifyInstance;
  readonly clock: ManualClock;
  readonly pool: Pool;
  readonly config: Config;
  readonly accounts: AccountService;
  close(): Promise<void>;
}

export function testConfig(env: Record<string, string> = {}): Config {
  return loadConfig({
    NODE_ENV: "test",
    LOG_LEVEL: process.env.TEST_LOG_LEVEL ?? "silent",
    DATABASE_URL: testDatabaseUrl(),
    ...env,
  });
}

/** The real application on the test database, with a manual clock. */
export async function buildTestApp(
  overrides: { env?: Record<string, string>; clock?: ManualClock } = {},
): Promise<TestApp> {
  const config = testConfig(overrides.env);
  const clock = overrides.clock ?? new ManualClock();
  const pool = testPool();
  const deps: AppDeps = { pool, clock, logger: createLogger({ level: config.logLevel }), config };
  const app = await buildApp(deps);
  await app.ready();
  return {
    app,
    clock,
    pool,
    config,
    accounts: new AccountService({ pool, clock }),
    close: () => app.close(),
  };
}
