import type { Pool, PoolClient } from "../db/pool.js";
import { withTransaction } from "../db/tx.js";
import type { OutboxEvent } from "../domain/events.js";
import type { WebhookEndpoint } from "../domain/webhook.js";
import type { Clock } from "../infra/clock.js";
import type { Logger } from "../infra/logger.js";
import * as endpoints from "../repositories/webhookEndpoints.js";
import * as outbox from "../repositories/outbox.js";
import { signatureHeader } from "./webhookSigner.js";
import type { WebhookSender } from "./webhookSender.js";

export interface OutboxDispatcherOptions {
  readonly pool: Pool;
  readonly clock: Clock;
  readonly sender: WebhookSender;
  readonly logger: Logger;
  readonly batchSize: number;
  readonly pollIntervalMs: number;
  readonly backoffBaseMs: number;
  readonly backoffMaxMs: number;
}

export interface DispatchSummary {
  readonly claimed: number;
  readonly delivered: number;
  readonly failed: number;
}

const MAX_ERROR_LENGTH = 1_000;

/**
 * Delivers outbox events to the tenant's active webhook endpoints.
 *
 * Ordering guarantee: events of the same aggregate (one transfer, one hold) are delivered in the
 * order they were created, and an event that fails holds back the later events of its aggregate
 * until it is delivered. `claimDueEvents` enforces this by only claiming an event when no earlier
 * event of its aggregate is still undelivered; events of different aggregates do not wait for
 * each other.
 *
 * Delivery is at least once: an event is marked delivered only after every endpoint accepted
 * it, and a failure at any endpoint retries the event for all of them. Receivers deduplicate on
 * the event id. Retries back off exponentially from `backoffBaseMs`, capped at `backoffMaxMs`.
 */
export class OutboxDispatcher {
  private readonly options: OutboxDispatcherOptions;
  private loop: Promise<void> | null = null;
  private stopping = false;
  private wake: (() => void) | null = null;

  constructor(options: OutboxDispatcherOptions) {
    this.options = options;
  }

  /**
   * Claim one batch of due events and deliver them one by one, in id order, inside a single
   * transaction. The claimed rows stay locked until it commits, so concurrent dispatchers skip
   * them instead of delivering them twice.
   */
  async runOnce(): Promise<DispatchSummary> {
    const { pool, clock, batchSize } = this.options;
    return withTransaction(pool, async (client) => {
      const events = await outbox.claimDueEvents(client, clock.now(), batchSize);
      const endpointsByTenant = new Map<string, WebhookEndpoint[]>();
      let delivered = 0;
      let failed = 0;
      for (const event of events) {
        let targets = endpointsByTenant.get(event.tenantId);
        if (!targets) {
          targets = await endpoints.listActiveEndpoints(client, event.tenantId);
          endpointsByTenant.set(event.tenantId, targets);
        }
        if (await this.deliver(client, event, targets)) {
          delivered++;
        } else {
          failed++;
        }
      }
      return { claimed: events.length, delivered, failed };
    });
  }

  /** Delay before the next attempt once an event has failed `attempts` times. */
  backoffDelayMs(attempts: number): number {
    const { backoffBaseMs, backoffMaxMs } = this.options;
    const exponent = Math.min(Math.max(attempts - 1, 0), 30);
    return Math.min(backoffBaseMs * 2 ** exponent, backoffMaxMs);
  }

  /** Run batches until `stop()`: back to back while there is a backlog, else every poll interval. */
  start(): void {
    if (this.loop) return;
    this.stopping = false;
    this.loop = this.runLoop();
  }

  /** Finish the batch in progress, then stop. */
  async stop(): Promise<void> {
    this.stopping = true;
    this.wake?.();
    await this.loop;
    this.loop = null;
  }

  private async runLoop(): Promise<void> {
    const { logger, batchSize, pollIntervalMs } = this.options;
    while (!this.stopping) {
      let claimed = 0;
      try {
        const summary = await this.runOnce();
        claimed = summary.claimed;
        if (summary.claimed > 0) {
          logger.info(summary, "outbox batch dispatched");
        }
      } catch (err) {
        logger.error({ err }, "outbox dispatch failed");
      }
      if (claimed < batchSize && !this.stopping) {
        await this.sleep(pollIntervalMs);
      }
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.wake = null;
        resolve();
      }, ms);
      this.wake = () => {
        clearTimeout(timer);
        this.wake = null;
        resolve();
      };
    });
  }

  private async deliver(
    client: PoolClient,
    event: OutboxEvent,
    targets: readonly WebhookEndpoint[],
  ): Promise<boolean> {
    const { clock, sender, logger } = this.options;
    const body = JSON.stringify({
      id: event.id,
      type: event.eventType,
      created_at: event.createdAt.toISOString(),
      data: event.payload,
    });
    let failure: { error: unknown } | null = null;
    try {
      for (const endpoint of targets) {
        await sender.send({
          endpointId: endpoint.id,
          url: endpoint.url,
          body,
          headers: {
            "x-ledger-event-id": event.id,
            "x-ledger-event-type": event.eventType,
            "x-ledger-signature": signatureHeader(endpoint.secret, body, clock.now()),
          },
        });
      }
    } catch (error) {
      failure = { error };
    }
    if (failure === null) {
      await outbox.markDelivered(client, event.id, clock.now());
      return true;
    }
    const attempts = event.attempts + 1;
    const nextAttemptAt = new Date(clock.now().getTime() + this.backoffDelayMs(attempts));
    const message = failure.error instanceof Error ? failure.error.message : String(failure.error);
    await outbox.markFailed(client, event.id, {
      attempts,
      nextAttemptAt,
      error: message.slice(0, MAX_ERROR_LENGTH),
    });
    logger.warn(
      { eventId: event.id, eventType: event.eventType, attempts, nextAttemptAt, err: failure.error },
      "webhook delivery failed",
    );
    return false;
  }
}
