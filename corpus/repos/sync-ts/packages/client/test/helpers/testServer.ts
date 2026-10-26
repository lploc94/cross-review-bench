import { ManualClock } from "@sync/shared";
import {
  AccountService,
  buildApp,
  createLogger,
  createPool,
  loadConfig,
  type Config,
  type Pool,
} from "@sync/server";

/** The server application (a Fastify instance). */
export type ServerApp = Awaited<ReturnType<typeof buildApp>>;

/** A device's credentials on the test server. */
export interface TestAccount {
  readonly userId: string;
  readonly deviceId: string;
  readonly token: string;
}

/** The real sync server, in process, on the test database, with its own manual clock. */
export interface TestServer {
  readonly app: ServerApp;
  readonly clock: ManualClock;
  readonly pool: Pool;
  readonly config: Config;
  createUser(name?: string): Promise<TestAccount>;
  addDevice(account: TestAccount, name?: string): Promise<TestAccount>;
  /** Number of events stored for the user. */
  countEvents(userId: string): Promise<number>;
  close(): Promise<void>;
}

let users = 0;

export async function startTestServer(
  options: { clock?: ManualClock; env?: Record<string, string> } = {},
): Promise<TestServer> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL must point at an empty test database");
  const config = loadConfig({
    NODE_ENV: "test",
    LOG_LEVEL: process.env.TEST_LOG_LEVEL ?? "silent",
    DATABASE_URL: url,
    ...options.env,
  });
  const clock = options.clock ?? new ManualClock();
  const logger = createLogger({ level: config.logLevel });
  const pool = createPool({ connectionString: url, max: 5, logger });
  const app = await buildApp({ pool, clock, logger, config });
  await app.ready();
  const accounts = new AccountService({ pool, clock });
  return {
    app,
    clock,
    pool,
    config,
    async createUser(name = "Ada") {
      users += 1;
      const created = await accounts.createUser({
        email: `${name.toLowerCase()}.${users}@example.test`,
        displayName: name,
        deviceName: `${name}'s laptop`,
      });
      return { userId: created.user.id, deviceId: created.device.id, token: created.token };
    },
    async addDevice(account, name = "phone") {
      const registered = await accounts.registerDevice(account.userId, name);
      return { userId: account.userId, deviceId: registered.device.id, token: registered.token };
    },
    async countEvents(userId) {
      const result = await pool.query<{ count: string }>("SELECT count(*) AS count FROM events WHERE user_id = $1", [userId]);
      return Number(result.rows[0]?.count ?? 0);
    },
    async close() {
      await app.close();
      await pool.end();
    },
  };
}
