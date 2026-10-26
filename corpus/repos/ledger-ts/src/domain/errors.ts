/**
 * Errors the API reports to clients. Each carries a stable machine-readable `code` and the HTTP
 * status the error handler answers with; anything that is not a DomainError is a 500.
 */
export type ErrorDetails = Record<string, unknown> | unknown[];

export abstract class DomainError extends Error {
  abstract readonly code: string;
  abstract readonly httpStatus: number;
  readonly details: ErrorDetails | undefined;

  constructor(message: string, details?: ErrorDetails) {
    super(message);
    this.name = new.target.name;
    this.details = details;
  }
}

export class NotFoundError extends DomainError {
  readonly code = "not_found";
  readonly httpStatus = 404;

  static resource(resource: string, id: string): NotFoundError {
    return new NotFoundError(`${resource} ${id} not found`, { resource, id });
  }
}

export class ValidationError extends DomainError {
  readonly code = "validation_error";
  readonly httpStatus = 400;
}

export class ConflictError extends DomainError {
  readonly code: string = "conflict";
  readonly httpStatus = 409;
}

export class ForbiddenError extends DomainError {
  readonly code = "forbidden";
  readonly httpStatus = 403;
}

export class UnauthorizedError extends DomainError {
  readonly code = "unauthorized";
  readonly httpStatus = 401;
}

export class InsufficientFundsError extends DomainError {
  readonly code = "insufficient_funds";
  readonly httpStatus = 422;

  constructor(accountId: string, available: bigint, requested: bigint) {
    super(`account ${accountId} has insufficient available funds`, {
      account_id: accountId,
      available: available.toString(),
      requested: requested.toString(),
    });
  }
}

export class IdempotencyConflictError extends ConflictError {
  override readonly code = "idempotency_conflict";

  constructor(key: string) {
    super(`Idempotency-Key ${key} was already used with a different request`, { key });
  }
}

export class CurrencyMismatchError extends DomainError {
  readonly code = "currency_mismatch";
  readonly httpStatus = 422;

  constructor(expected: string, actual: string, details?: ErrorDetails) {
    super(`currency mismatch: expected ${expected}, got ${actual}`, {
      expected,
      actual,
      ...(details && !Array.isArray(details) ? details : {}),
    });
  }
}

export class AccountClosedError extends DomainError {
  readonly code = "account_closed";
  readonly httpStatus = 422;

  constructor(accountId: string) {
    super(`account ${accountId} is closed`, { account_id: accountId });
  }
}

export class HoldStateError extends DomainError {
  readonly code = "invalid_hold_state";
  readonly httpStatus = 409;
}

export class RateLimitedError extends DomainError {
  readonly code = "rate_limited";
  readonly httpStatus = 429;
  readonly retryAfterSeconds: number;

  constructor(retryAfterSeconds: number) {
    super("rate limit exceeded, retry later", { retry_after_seconds: retryAfterSeconds });
    this.retryAfterSeconds = retryAfterSeconds;
  }
}
