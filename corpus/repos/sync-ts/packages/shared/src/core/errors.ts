/**
 * Errors shared by the server and the client. Every sync failure is a SyncError with a stable
 * machine-readable `code` and a `retryable` flag: true when repeating the same operation later
 * can succeed (a network failure, a server error), false when it cannot (invalid input, a
 * protocol mismatch).
 */
export type SyncErrorDetails = Readonly<Record<string, unknown>>;

export interface SyncErrorOptions {
  readonly retryable?: boolean;
  readonly details?: SyncErrorDetails;
  readonly cause?: unknown;
}

export class SyncError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly details: SyncErrorDetails | undefined;

  constructor(code: string, message: string, options: SyncErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = new.target.name;
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.details = options.details;
  }
}

/** A timestamp that is not a valid hybrid logical clock value. */
export class InvalidHlcError extends SyncError {
  constructor(message: string, details?: SyncErrorDetails) {
    super("invalid_hlc", message, { details });
  }
}

/**
 * A remote timestamp is further ahead of the local physical clock than the allowed drift. The
 * clock refuses it rather than dragging every later timestamp into the future.
 */
export class ClockDriftError extends SyncError {
  readonly remoteWallMs: number;
  readonly physicalMs: number;
  readonly maxDriftMs: number;

  constructor(remoteWallMs: number, physicalMs: number, maxDriftMs: number) {
    super(
      "clock_drift",
      `remote clock is ${remoteWallMs - physicalMs} ms ahead of the local clock (at most ${maxDriftMs} ms allowed)`,
      { details: { remoteWallMs, physicalMs, maxDriftMs } },
    );
    this.remoteWallMs = remoteWallMs;
    this.physicalMs = physicalMs;
    this.maxDriftMs = maxDriftMs;
  }
}

/**
 * More logical ticks within one millisecond than the counter can hold. Retryable: once the
 * physical clock moves on, the counter starts over.
 */
export class HlcCounterOverflowError extends SyncError {
  constructor(wallMs: number) {
    super("hlc_counter_overflow", `logical counter overflow at ${wallMs}`, {
      retryable: true,
      details: { wallMs },
    });
  }
}

export interface FieldIssue {
  /** The field name, or "" for an issue with the mutation as a whole. */
  readonly field: string;
  readonly message: string;
}

/** A field write that the collection's schema rejects. */
export class MutationValidationError extends SyncError {
  readonly issues: readonly FieldIssue[];

  constructor(message: string, issues: readonly FieldIssue[]) {
    super("invalid_mutation", message, { details: { issues } });
    this.issues = issues;
  }
}
