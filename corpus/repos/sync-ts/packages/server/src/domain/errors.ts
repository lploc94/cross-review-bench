import type { FieldIssue } from "@sync/shared";

/**
 * Errors the API reports to clients. Each carries a stable machine-readable `code` and the HTTP
 * status the error handler answers with; anything that is not a DomainError is a 500.
 */
export type ErrorDetails = Record<string, unknown> | unknown[];

export abstract class DomainError extends Error {
  abstract readonly code: string;
  abstract readonly httpStatus: number;
  readonly details: ErrorDetails | undefined;

  constructor(message: string, details?: ErrorDetails, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
    this.details = details;
  }
}

export class ValidationError extends DomainError {
  readonly code = "validation_error";
  readonly httpStatus = 400;
}

export class UnauthorizedError extends DomainError {
  readonly code = "unauthorized";
  readonly httpStatus = 401;
}

export class NotFoundError extends DomainError {
  readonly code = "not_found";
  readonly httpStatus = 404;

  static resource(resource: string, id: string): NotFoundError {
    return new NotFoundError(`${resource} ${id} not found`, { resource, id });
  }
}

export class ConflictError extends DomainError {
  readonly code: string = "conflict";
  readonly httpStatus = 409;
}

/** Another user already has this email address. */
export class EmailTakenError extends ConflictError {
  override readonly code = "email_taken";

  constructor(email: string) {
    super(`a user with email ${email} already exists`, { email });
  }
}

/**
 * One mutation of a push cannot be applied: unknown collection, unknown field, a value of the
 * wrong type, a duplicate id within the request. The whole push is rejected; `index` is the
 * mutation's position in the request.
 */
export class InvalidMutationError extends DomainError {
  readonly code = "invalid_mutation";
  readonly httpStatus = 422;
  readonly index: number;

  constructor(index: number, mutationId: string, issues: readonly FieldIssue[], summary?: string) {
    super(summary ?? `mutation ${index} (${mutationId}) is invalid`, { index, mutationId, issues });
    this.index = index;
  }
}

/** A mutation's timestamp is further in the future than the server accepts. */
export class ClockDriftRejectedError extends DomainError {
  readonly code = "clock_drift";
  readonly httpStatus = 422;
  readonly index: number;

  constructor(index: number, mutationId: string, driftMs: number, maxDriftMs: number) {
    super(
      `mutation ${index} (${mutationId}) is timestamped ${driftMs} ms ahead of the server clock (at most ${maxDriftMs} ms allowed)`,
      { index, mutationId, driftMs, maxDriftMs },
    );
    this.index = index;
  }
}

/** The request declares another protocol version than the server speaks, or none. */
export class ProtocolMismatchError extends DomainError {
  readonly code = "protocol_mismatch";
  readonly httpStatus = 426;
  readonly serverVersion: number;

  constructor(serverVersion: number, requested: number | null) {
    super(
      requested === null
        ? `the Sync-Protocol header is required (server speaks version ${serverVersion})`
        : `protocol version ${requested} is not supported (server speaks version ${serverVersion})`,
      { serverVersion, requestedVersion: requested },
    );
    this.serverVersion = serverVersion;
  }
}

/** The user already has the most devices allowed. */
export class DeviceLimitError extends ConflictError {
  override readonly code = "device_limit";

  constructor(limit: number) {
    super(`a user can have at most ${limit} devices`, { limit });
  }
}

/** The server cannot take the request right now; the same request can succeed later. */
export class UnavailableError extends DomainError {
  readonly code = "unavailable";
  readonly httpStatus = 503;
}
