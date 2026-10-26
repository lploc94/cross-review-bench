import { availableBalance, type Account } from "../domain/account.js";
import type { OutboxEvent } from "../domain/events.js";
import { formatRate, type FxRate } from "../domain/fx.js";
import type { Hold } from "../domain/hold.js";
import type { JsonObject } from "../domain/json.js";
import type { Page } from "../domain/pagination.js";
import type { Entry, Transfer } from "../domain/transfer.js";
import type { WebhookEndpoint } from "../domain/webhook.js";
import type { FxQuote } from "../services/fxService.js";

/*
 * JSON representations of the resources. Amounts are decimal integer strings of minor units and
 * timestamps ISO 8601 strings in UTC; field names are snake_case.
 */

export function serializeAccount(account: Account): JsonObject {
  return {
    id: account.id,
    name: account.name,
    currency: account.currency,
    kind: account.kind,
    status: account.status,
    balance: account.balanceMinor.toString(),
    held: account.heldMinor.toString(),
    available: availableBalance(account).toString(),
    created_at: account.createdAt.toISOString(),
    updated_at: account.updatedAt.toISOString(),
  };
}

export function serializeTransfer(transfer: Transfer): JsonObject {
  return {
    id: transfer.id,
    from_account_id: transfer.fromAccountId,
    to_account_id: transfer.toAccountId,
    amount: transfer.amountMinor.toString(),
    currency: transfer.currency,
    description: transfer.description,
    metadata: { ...transfer.metadata },
    status: transfer.status,
    created_at: transfer.createdAt.toISOString(),
  };
}

export function serializeEntry(entry: Entry): JsonObject {
  return {
    id: entry.id,
    transfer_id: entry.transferId,
    account_id: entry.accountId,
    amount: entry.amountMinor.toString(),
    currency: entry.currency,
    balance_after: entry.balanceAfter.toString(),
    created_at: entry.createdAt.toISOString(),
  };
}

export function serializeTransferWithEntries(
  transfer: Transfer,
  entries: readonly Entry[],
): JsonObject {
  return { ...serializeTransfer(transfer), entries: entries.map(serializeEntry) };
}

export function serializeHold(hold: Hold): JsonObject {
  return {
    id: hold.id,
    account_id: hold.accountId,
    amount: hold.amountMinor.toString(),
    currency: hold.currency,
    status: hold.status,
    expires_at: hold.expiresAt.toISOString(),
    captured_transfer_id: hold.capturedTransferId,
    created_at: hold.createdAt.toISOString(),
    updated_at: hold.updatedAt.toISOString(),
  };
}

export function serializeRate(rate: FxRate): JsonObject {
  return {
    base: rate.base,
    quote: rate.quote,
    rate: formatRate(rate.rateScaled),
    rate_scaled: rate.rateScaled.toString(),
    effective_at: rate.effectiveAt.toISOString(),
  };
}

export function serializeQuote(quote: FxQuote): JsonObject {
  return {
    from: quote.from,
    to: quote.to,
    amount: quote.amountMinor.toString(),
    converted_amount: quote.convertedMinor.toString(),
    rate: formatRate(quote.rate.rateScaled),
    rate_scaled: quote.rate.rateScaled.toString(),
    effective_at: quote.rate.effectiveAt.toISOString(),
  };
}

/** Endpoints are listed without their secret; it is only returned when the endpoint is created. */
export function serializeWebhookEndpoint(
  endpoint: WebhookEndpoint,
  options: { includeSecret?: boolean } = {},
): JsonObject {
  return {
    id: endpoint.id,
    url: endpoint.url,
    active: endpoint.active,
    created_at: endpoint.createdAt.toISOString(),
    ...(options.includeSecret ? { secret: endpoint.secret } : {}),
  };
}

/** An event as delivered to webhooks, plus where its delivery stands. */
export function serializeEvent(event: OutboxEvent): JsonObject {
  return {
    id: event.id,
    type: event.eventType,
    aggregate_id: event.aggregateId,
    created_at: event.createdAt.toISOString(),
    data: event.payload,
    delivery: {
      status: event.deliveredAt ? "delivered" : "pending",
      attempts: event.attempts,
      delivered_at: event.deliveredAt?.toISOString() ?? null,
      next_attempt_at: event.deliveredAt ? null : event.nextAttemptAt.toISOString(),
      last_error: event.lastError,
    },
  };
}

export function serializePage<T>(page: Page<T>, serialize: (item: T) => JsonObject): JsonObject {
  return {
    data: page.items.map(serialize),
    pagination: { limit: page.limit, offset: page.offset, has_more: page.hasMore },
  };
}
