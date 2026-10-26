import type { AccountService } from "../../services/accountService.js";
import type { EventService } from "../../services/eventService.js";
import type { FxService } from "../../services/fxService.js";
import type { HoldService } from "../../services/holdService.js";
import type { TransferService } from "../../services/transferService.js";
import type { WebhookService } from "../../services/webhookService.js";

/** The services the authenticated routes call, handed to each route plugin as its options. */
export interface RouteServices {
  readonly accounts: AccountService;
  readonly transfers: TransferService;
  readonly holds: HoldService;
  readonly fx: FxService;
  readonly webhooks: WebhookService;
  readonly events: EventService;
}

export interface RouteOptions {
  readonly services: RouteServices;
}
