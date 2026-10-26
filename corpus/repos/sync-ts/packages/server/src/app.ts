import { Hlc, type PhysicalClock } from "@sync/shared";
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from "fastify";
import { registerErrorHandling } from "./api/plugins/errorHandler.js";
import { announceProtocol } from "./api/plugins/protocol.js";
import { registerRoutes } from "./api/routes/index.js";
import type { RouteLimits, RouteServices } from "./api/routes/types.js";
import type { Config } from "./config/env.js";
import type { Pool } from "./db/pool.js";
import type { Logger } from "./infra/logger.js";
import { AccountService } from "./services/accountService.js";
import { AuthService } from "./services/authService.js";
import { DocumentService } from "./services/documentService.js";
import { PullService } from "./services/pullService.js";
import { PushService } from "./services/pushService.js";

export interface AppDeps {
  readonly pool: Pool;
  /** Physical time: the server's HLC and every timestamp it writes. */
  readonly clock: PhysicalClock;
  readonly logger: Logger;
  readonly config: Config;
}

/** The server's hybrid logical clock; one per process, shared by every request. */
export function createServerHlc(deps: Pick<AppDeps, "clock" | "config">): Hlc {
  return new Hlc({
    node: deps.config.sync.serverNodeId,
    clock: deps.clock,
    maxDriftMs: deps.config.sync.maxClockDriftMs,
  });
}

export function buildServices(deps: AppDeps, hlc: Hlc = createServerHlc(deps)): RouteServices {
  const { pool, clock, logger } = deps;
  return {
    auth: new AuthService({ pool, clock }),
    accounts: new AccountService({ pool, clock }),
    push: new PushService({ pool, clock, hlc, logger: logger.child({ component: "push" }) }),
    pull: new PullService({ pool, clock }),
    documents: new DocumentService({ pool }),
  };
}

export function routeLimits(config: Config): RouteLimits {
  return {
    pushMaxMutations: config.sync.pushMaxMutations,
    pullMaxLimit: config.sync.pullMaxLimit,
    pullDefaultLimit: config.sync.pullDefaultLimit,
  };
}

/** The HTTP application. */
export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const loggerInstance: FastifyBaseLogger = deps.logger;
  const app = Fastify({
    loggerInstance,
    bodyLimit: deps.config.bodyLimitBytes,
    requestIdHeader: "x-request-id",
    return503OnClosing: true,
  });
  app.decorateRequest("auth", null);
  registerErrorHandling(app);
  announceProtocol(app);
  await registerRoutes(app, {
    services: buildServices(deps),
    limits: routeLimits(deps.config),
    pool: deps.pool,
  });
  return app;
}
