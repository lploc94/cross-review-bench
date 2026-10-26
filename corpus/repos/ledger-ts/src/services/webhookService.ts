import type { Pool } from "../db/pool.js";
import { withTransaction } from "../db/tx.js";
import { ConflictError, NotFoundError } from "../domain/errors.js";
import { generateWebhookSecret, type WebhookEndpoint } from "../domain/webhook.js";
import type { Clock } from "../infra/clock.js";
import * as endpoints from "../repositories/webhookEndpoints.js";

export const MAX_ACTIVE_ENDPOINTS = 10;

export class WebhookService {
  private readonly pool: Pool;
  private readonly clock: Clock;

  constructor(deps: { pool: Pool; clock: Clock }) {
    this.pool = deps.pool;
    this.clock = deps.clock;
  }

  /**
   * Register an endpoint with a fresh signing secret. The secret is only ever returned here. The
   * per-tenant transaction-level advisory lock makes the endpoint limit hold under concurrency.
   */
  async createEndpoint(tenantId: string, url: string): Promise<WebhookEndpoint> {
    return withTransaction(this.pool, async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
        `webhook_endpoints:${tenantId}`,
      ]);
      const active = await endpoints.countActiveEndpoints(client, tenantId);
      if (active >= MAX_ACTIVE_ENDPOINTS) {
        throw new ConflictError(`a tenant can have at most ${MAX_ACTIVE_ENDPOINTS} webhook endpoints`);
      }
      return endpoints.insertEndpoint(client, {
        tenantId,
        url,
        secret: generateWebhookSecret(),
        createdAt: this.clock.now(),
      });
    });
  }

  async listEndpoints(tenantId: string): Promise<WebhookEndpoint[]> {
    return endpoints.listActiveEndpoints(this.pool, tenantId);
  }

  /** Stop deliveries to the endpoint. Events already being delivered may still reach it once. */
  async deleteEndpoint(tenantId: string, id: string): Promise<void> {
    const removed = await endpoints.deactivateEndpoint(this.pool, tenantId, id);
    if (!removed) throw NotFoundError.resource("webhook endpoint", id);
  }
}
