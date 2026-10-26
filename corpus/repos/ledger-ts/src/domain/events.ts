import type { Hold } from "./hold.js";
import type { JsonObject } from "./json.js";
import type { Transfer } from "./transfer.js";

export const EVENT_TYPES = ["transfer.posted", "hold.created", "hold.captured", "hold.voided"] as const;
export type EventType = (typeof EVENT_TYPES)[number];

/**
 * An event to write to the outbox in the same transaction as the change it describes. Events of
 * one aggregate (a transfer, a hold) are delivered in the order they were written.
 */
export interface NewEvent {
  readonly tenantId: string;
  readonly aggregateId: string;
  readonly eventType: EventType;
  readonly payload: JsonObject;
}

export interface OutboxEvent {
  readonly id: string;
  readonly tenantId: string;
  readonly aggregateId: string;
  readonly eventType: string;
  readonly payload: JsonObject;
  readonly createdAt: Date;
  readonly attempts: number;
  readonly nextAttemptAt: Date;
  readonly deliveredAt: Date | null;
  readonly lastError: string | null;
}

function transferPayload(transfer: Transfer): JsonObject {
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

function holdPayload(hold: Hold): JsonObject {
  return {
    id: hold.id,
    account_id: hold.accountId,
    amount: hold.amountMinor.toString(),
    currency: hold.currency,
    status: hold.status,
    expires_at: hold.expiresAt.toISOString(),
    captured_transfer_id: hold.capturedTransferId,
  };
}

export function transferPosted(transfer: Transfer): NewEvent {
  return {
    tenantId: transfer.tenantId,
    aggregateId: transfer.id,
    eventType: "transfer.posted",
    payload: { transfer: transferPayload(transfer) },
  };
}

export function holdCreated(hold: Hold): NewEvent {
  return {
    tenantId: hold.tenantId,
    aggregateId: hold.id,
    eventType: "hold.created",
    payload: { hold: holdPayload(hold) },
  };
}

export function holdCaptured(hold: Hold, transfer: Transfer): NewEvent {
  return {
    tenantId: hold.tenantId,
    aggregateId: hold.id,
    eventType: "hold.captured",
    payload: { hold: holdPayload(hold), transfer: transferPayload(transfer) },
  };
}

export function holdVoided(hold: Hold): NewEvent {
  return {
    tenantId: hold.tenantId,
    aggregateId: hold.id,
    eventType: "hold.voided",
    payload: { hold: holdPayload(hold) },
  };
}
