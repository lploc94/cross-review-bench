import type { CurrencyCode } from "./currency.js";
import { HoldStateError } from "./errors.js";

export const HOLD_STATUSES = ["active", "captured", "voided", "expired"] as const;
export type HoldStatus = (typeof HOLD_STATUSES)[number];

export const MIN_HOLD_SECONDS = 60;
export const MAX_HOLD_SECONDS = 7 * 24 * 60 * 60;

/**
 * A reservation of funds on an account. While active, its amount counts in the account's
 * `held_minor` and cannot be spent; capturing it moves the amount to another account.
 */
export interface Hold {
  readonly id: string;
  readonly tenantId: string;
  readonly accountId: string;
  readonly amountMinor: bigint;
  readonly currency: CurrencyCode;
  readonly status: HoldStatus;
  readonly expiresAt: Date;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly capturedTransferId: string | null;
}

export function holdExpiry(now: Date, expiresInSeconds: number): Date {
  return new Date(now.getTime() + expiresInSeconds * 1000);
}

/** A hold is valid while now < expires_at; from expires_at on it can no longer be captured. */
export function isExpired(hold: Pick<Hold, "expiresAt">, now: Date): boolean {
  return now.getTime() >= hold.expiresAt.getTime();
}

/** The error to report for a hold that a state change could not apply to. */
const PAST_TENSE = { capture: "captured", void: "voided" } as const;

export function holdStateError(hold: Hold, action: "capture" | "void", now: Date): HoldStateError {
  if (hold.status !== "active") {
    return new HoldStateError(`hold ${hold.id} is ${hold.status} and cannot be ${PAST_TENSE[action]}`, {
      hold_id: hold.id,
      status: hold.status,
    });
  }
  if (action === "capture" && isExpired(hold, now)) {
    return new HoldStateError(`hold ${hold.id} expired at ${hold.expiresAt.toISOString()}`, {
      hold_id: hold.id,
      status: hold.status,
      expires_at: hold.expiresAt.toISOString(),
    });
  }
  return new HoldStateError(`hold ${hold.id} changed while it was being ${PAST_TENSE[action]}`, {
    hold_id: hold.id,
    status: hold.status,
  });
}
