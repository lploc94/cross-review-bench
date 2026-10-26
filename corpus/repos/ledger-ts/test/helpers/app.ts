import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from "fastify";
import { buildApp, createOutboxDispatcher } from "../../src/app.js";
import { loadConfig, type Config } from "../../src/config/env.js";
import type { Pool } from "../../src/db/pool.js";
import { createLogger } from "../../src/infra/logger.js";
import type { RateLimiter } from "../../src/infra/rateLimiter.js";
import type { Redis } from "../../src/infra/redis.js";
import type { OutboxDispatcher } from "../../src/services/outboxDispatcher.js";
import { ManualClock } from "./clock.js";
import { testPool, testRedis } from "./db.js";
import { testDatabaseUrl, testRedisUrl } from "./env.js";
import { FakeWebhookSender } from "./fakeWebhookSender.js";

export interface TestApp {
  readonly app: FastifyInstance;
  readonly clock: ManualClock;
  readonly sender: FakeWebhookSender;
  readonly pool: Pool;
  readonly redis: Redis;
  readonly config: Config;
  readonly dispatcher: OutboxDispatcher;
  close(): Promise<void>;
}

export interface TestAppOptions {
  /** Environment overrides on top of the test defaults, e.g. { RATE_LIMIT_PER_MINUTE: "3" }. */
  readonly env?: Record<string, string>;
  readonly clock?: ManualClock;
  readonly rateLimiter?: RateLimiter;
}

export function testConfig(env: Record<string, string> = {}): Config {
  return loadConfig({
    NODE_ENV: "test",
    LOG_LEVEL: process.env.TEST_LOG_LEVEL ?? "silent",
    DATABASE_URL: testDatabaseUrl(),
    REDIS_URL: testRedisUrl(),
    RATE_LIMIT_PER_MINUTE: "10000",
    OUTBOX_BACKOFF_BASE_MS: "1000",
    OUTBOX_BACKOFF_MAX_MS: "60000",
    ...env,
  });
}

/** The real application wired to the test database and Redis, a manual clock and a fake sender. */
export async function buildTestApp(options: TestAppOptions = {}): Promise<TestApp> {
  const config = testConfig(options.env);
  const clock = options.clock ?? new ManualClock();
  const sender = new FakeWebhookSender();
  const logger = createLogger({ level: config.logLevel });
  const pool = testPool();
  const redis = testRedis();
  const deps = { pool, redis, clock, logger, sender, config };
  const app = await buildApp(
    options.rateLimiter ? { ...deps, rateLimiter: options.rateLimiter } : deps,
  );
  await app.ready();
  return {
    app,
    clock,
    sender,
    pool,
    redis,
    config,
    dispatcher: createOutboxDispatcher(deps),
    close: () => app.close(),
  };
}

/** Parsed JSON body of an injected response. */
export function json<T = Record<string, unknown>>(response: LightMyRequestResponse): T {
  return response.json<T>();
}

export type Request = InjectOptions;
