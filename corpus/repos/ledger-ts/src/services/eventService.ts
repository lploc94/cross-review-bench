import type { Pool } from "../db/pool.js";
import { NotFoundError } from "../domain/errors.js";
import type { OutboxEvent } from "../domain/events.js";
import { toPage, type OffsetPage, type Page } from "../domain/pagination.js";
import * as outbox from "../repositories/outbox.js";
import type { EventFilter } from "../repositories/outbox.js";

/**
 * Read access to the events the ledger has emitted, with their delivery state, so that a tenant
 * can see what its webhook endpoints were sent and catch up on anything they missed.
 */
export class EventService {
  private readonly pool: Pool;

  constructor(deps: { pool: Pool }) {
    this.pool = deps.pool;
  }

  async listEvents(tenantId: string, filter: EventFilter, page: OffsetPage): Promise<Page<OutboxEvent>> {
    const rows = await outbox.listEvents(this.pool, tenantId, filter, page);
    return toPage(rows, page);
  }

  async getEvent(tenantId: string, id: string): Promise<OutboxEvent> {
    const event = await outbox.findEvent(this.pool, tenantId, id);
    if (!event) throw NotFoundError.resource("event", id);
    return event;
  }
}
