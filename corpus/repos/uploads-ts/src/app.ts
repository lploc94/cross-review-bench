import Fastify, { type FastifyBaseLogger, type FastifyInstance } from "fastify";
import { registerErrorHandling } from "./api/plugins/errorHandler.js";
import { registerRoutes } from "./api/routes/index.js";
import type { RouteLimits, RouteServices } from "./api/routes/types.js";
import type { Config } from "./config/env.js";
import type { Pool } from "./db/pool.js";
import type { Clock } from "./infra/clock.js";
import type { Logger } from "./infra/logger.js";
import { ApiKeyService } from "./services/apiKeyService.js";
import { CleanupService } from "./services/cleanup.js";
import { FileCatalog } from "./services/fileCatalog.js";
import { FileService } from "./services/fileService.js";
import { ResumableUploadService } from "./services/resumable.js";
import { HttpScanner, NoopScanner, type Scanner } from "./services/scanner.js";
import { ScanWorker } from "./services/scanWorker.js";
import { TenantService } from "./services/tenantService.js";
import { UploadService } from "./services/uploadService.js";
import { UrlSigner } from "./services/urlSigner.js";
import type { StorageDriver } from "./storage/driver.js";

export interface AppDeps {
  readonly pool: Pool;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly storage: StorageDriver;
  readonly scanner: Scanner;
  readonly config: Config;
}

/** JSON request bodies are small; file bytes go through raw-body routes with their own limit. */
const JSON_BODY_LIMIT_BYTES = 64 * 1024;

export function buildServices(deps: AppDeps): RouteServices {
  const { pool, clock, logger, storage, config } = deps;
  const catalog = new FileCatalog({ pool, clock, logger, storage });
  return {
    apiKeys: new ApiKeyService({ pool, clock }),
    tenants: new TenantService({ pool, clock }),
    files: new FileService({
      pool,
      clock,
      logger,
      storage,
      catalog,
      signer: new UrlSigner(config.signing.secret),
      signedUrlMaxTtlSeconds: config.signing.maxTtlSeconds,
      listMaxLimit: config.listMaxLimit,
    }),
    uploads: new UploadService({
      pool,
      clock,
      logger,
      storage,
      catalog,
      maxUploadBytes: config.uploads.maxUploadBytes,
    }),
    resumable: new ResumableUploadService({
      pool,
      clock,
      logger,
      storage,
      catalog,
      maxUploadBytes: config.uploads.maxUploadBytes,
      sessionTtlSeconds: config.uploads.sessionTtlSeconds,
      chunkLeaseSeconds: config.uploads.chunkLeaseSeconds,
    }),
  };
}

export function routeLimits(config: Config): RouteLimits {
  return {
    maxUploadBytes: config.uploads.maxUploadBytes,
    listMaxLimit: config.listMaxLimit,
    signedUrlMaxTtlSeconds: config.signing.maxTtlSeconds,
  };
}

/** The HTTP application. */
export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const loggerInstance: FastifyBaseLogger = deps.logger;
  const app = Fastify({
    loggerInstance,
    bodyLimit: JSON_BODY_LIMIT_BYTES,
    requestIdHeader: "x-request-id",
    return503OnClosing: true,
    // GET handlers open storage streams; HEAD is only served where a route defines it.
    exposeHeadRoutes: false,
  });
  app.decorateRequest("auth", null);
  registerErrorHandling(app);
  await registerRoutes(app, {
    services: buildServices(deps),
    limits: routeLimits(deps.config),
    pool: deps.pool,
  });
  return app;
}

export function createScanner(config: Config["scanner"], logger: Logger): Scanner {
  if (config.kind === "http" && config.url !== null) {
    return new HttpScanner({ url: config.url, timeoutMs: config.timeoutMs, logger });
  }
  return new NoopScanner();
}

export function createScanWorker(deps: AppDeps): ScanWorker {
  return new ScanWorker({
    pool: deps.pool,
    clock: deps.clock,
    logger: deps.logger.child({ component: "scan" }),
    storage: deps.storage,
    scanner: deps.scanner,
    settings: deps.config.scan,
  });
}

export function createCleanupService(deps: AppDeps): CleanupService {
  return new CleanupService({
    pool: deps.pool,
    clock: deps.clock,
    logger: deps.logger.child({ component: "cleanup" }),
    storage: deps.storage,
    settings: deps.config.cleanup,
  });
}
