import Fastify, { type FastifyBaseLogger, type FastifyInstance } from "fastify";
import { registerErrorHandling } from "./api/plugins/errorHandler.js";
import { authenticate } from "./api/plugins/auth.js";
import { rateLimit } from "./api/plugins/rateLimit.js";
import { accountRoutes } from "./api/routes/accounts.js";
import { eventRoutes } from "./api/routes/events.js";
import { fxRoutes } from "./api/routes/fx.js";
import { healthRoutes } from "./api/routes/health.js";
import { holdRoutes } from "./api/routes/holds.js";
import { transferRoutes } from "./api/routes/transfers.js";
import type { RouteServices } from "./api/routes/types.js";
import { webhookRoutes } from "./api/routes/webhooks.js";
import type { Config } from "./config/env.js";
import type { Pool } from "./db/pool.js";
import type { Clock } from "./infra/clock.js";
import type { Logger } from "./infra/logger.js";
import { FixedWindowRateLimiter, type RateLimiter } from "./infra/rateLimiter.js";
import type { Redis } from "./infra/redis.js";
import { AccountService } from "./services/accountService.js";
import { EventService } from "./services/eventService.js";
import { ApiKeyService } from "./services/apiKeyService.js";
import { FxService } from "./services/fxService.js";
import { HoldService } from "./services/holdService.js";
import { OutboxDispatcher } from "./services/outboxDispatcher.js";
import { TransferService } from "./services/transferService.js";
import { WebhookService } from "./services/webhookService.js";
import type { WebhookSender } from "./services/webhookSender.js";

export interface AppDeps {
  readonly pool: Pool;
  readonly redis: Redis;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly sender: WebhookSender;
  readonly config: Config;
  /** Defaults to the Redis fixed-window limiter configured by RATE_LIMIT_PER_MINUTE. */
  readonly rateLimiter?: RateLimiter;
}

const BODY_LIMIT_BYTES = 256 * 1024;

export function buildServices(deps: Pick<AppDeps, "pool" | "clock">): RouteServices & {
  apiKeys: ApiKeyService;
} {
  const { pool, clock } = deps;
  return {
    accounts: new AccountService({ pool, clock }),
    transfers: new TransferService({ pool, clock }),
    holds: new HoldService({ pool, clock }),
    fx: new FxService({ pool, clock }),
    webhooks: new WebhookService({ pool, clock }),
    events: new EventService({ pool }),
    apiKeys: new ApiKeyService({ pool, clock }),
  };
}

/**
 * The HTTP application. Health checks are public; everything else sits behind API-key
 * authentication and the per-key rate limit, and each route checks its own scope.
 */
export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const loggerInstance: FastifyBaseLogger = deps.logger;
  const app = Fastify({
    loggerInstance,
    bodyLimit: BODY_LIMIT_BYTES,
    requestIdHeader: "x-request-id",
    return503OnClosing: true,
  });
  const services = buildServices(deps);
  const limiter =
    deps.rateLimiter ??
    new FixedWindowRateLimiter({
      redis: deps.redis,
      clock: deps.clock,
      limit: deps.config.rateLimitPerMinute,
    });

  app.decorateRequest("auth", null);
  registerErrorHandling(app);

  await app.register(healthRoutes);
  await app.register(async (api) => {
    api.addHook("onRequest", authenticate(services.apiKeys));
    api.addHook("onRequest", rateLimit(limiter));
    await api.register(accountRoutes, { services });
    await api.register(transferRoutes, { services });
    await api.register(holdRoutes, { services });
    await api.register(fxRoutes, { services });
    await api.register(webhookRoutes, { services });
    await api.register(eventRoutes, { services });
  });
  return app;
}

export function createOutboxDispatcher(
  deps: Pick<AppDeps, "pool" | "clock" | "logger" | "sender" | "config">,
): OutboxDispatcher {
  return new OutboxDispatcher({
    pool: deps.pool,
    clock: deps.clock,
    sender: deps.sender,
    logger: deps.logger.child({ component: "outbox" }),
    batchSize: deps.config.outbox.batchSize,
    pollIntervalMs: deps.config.outbox.pollIntervalMs,
    backoffBaseMs: deps.config.outbox.backoffBaseMs,
    backoffMaxMs: deps.config.outbox.backoffMaxMs,
  });
}
