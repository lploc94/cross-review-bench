import type { Pool } from "../../db/pool.js";
import type { AccountService } from "../../services/accountService.js";
import type { AuthService } from "../../services/authService.js";
import type { DocumentService } from "../../services/documentService.js";
import type { PullService } from "../../services/pullService.js";
import type { PushService } from "../../services/pushService.js";

/** The services the routes call, handed to each route plugin as its options. */
export interface RouteServices {
  readonly auth: AuthService;
  readonly accounts: AccountService;
  readonly push: PushService;
  readonly pull: PullService;
  readonly documents: DocumentService;
}

/** Limits the routes validate requests against (from the configuration). */
export interface RouteLimits {
  readonly pushMaxMutations: number;
  readonly pullMaxLimit: number;
  readonly pullDefaultLimit: number;
}

export interface RouteOptions {
  readonly services: RouteServices;
  readonly limits: RouteLimits;
  readonly pool: Pool;
}
