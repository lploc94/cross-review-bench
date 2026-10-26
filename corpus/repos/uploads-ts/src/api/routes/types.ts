import type { Pool } from "../../db/pool.js";
import type { ApiKeyService } from "../../services/apiKeyService.js";
import type { FileService } from "../../services/fileService.js";
import type { ResumableUploadService } from "../../services/resumable.js";
import type { TenantService } from "../../services/tenantService.js";
import type { UploadService } from "../../services/uploadService.js";

/** The services the routes call, handed to each route plugin as its options. */
export interface RouteServices {
  readonly apiKeys: ApiKeyService;
  readonly tenants: TenantService;
  readonly files: FileService;
  readonly uploads: UploadService;
  readonly resumable: ResumableUploadService;
}

/** Limits the routes validate requests against (from the configuration). */
export interface RouteLimits {
  readonly maxUploadBytes: number;
  readonly listMaxLimit: number;
  readonly signedUrlMaxTtlSeconds: number;
}

export interface RouteOptions {
  readonly services: RouteServices;
  readonly limits: RouteLimits;
  readonly pool: Pool;
}
