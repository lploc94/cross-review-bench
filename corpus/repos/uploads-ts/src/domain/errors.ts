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

/** A file already exists at the path and the request did not ask to replace it. */
export class PathConflictError extends ConflictError {
  override readonly code = "path_exists";

  constructor(path: string) {
    super(`a file already exists at ${path}; pass overwrite=true to replace it`, { path });
  }
}

/** The upload session cannot take this request in its current state. */
export class UploadSessionStateError extends ConflictError {
  override readonly code = "upload_session_state";

  constructor(sessionId: string, state: string, message?: string) {
    super(message ?? `upload session ${sessionId} is ${state}`, { sessionId, state });
  }
}

/** Another request is writing a chunk of the same upload session. */
export class ChunkInProgressError extends ConflictError {
  override readonly code = "chunk_in_progress";

  constructor(sessionId: string) {
    super(`another chunk of upload session ${sessionId} is being written`, {
      sessionId,
    });
  }
}

/** Completion was asked for before every byte arrived. */
export class UploadIncompleteError extends ConflictError {
  override readonly code = "upload_incomplete";

  constructor(sessionId: string, offset: number, size: number) {
    super(`upload session ${sessionId} has ${offset} of ${size} bytes`, {
      sessionId,
      offset,
      size,
    });
  }
}

export class ForbiddenError extends DomainError {
  readonly code: string = "forbidden";
  readonly httpStatus = 403;
}

/** A signed download URL whose signature does not match, or that is malformed. */
export class InvalidSignatureError extends ForbiddenError {
  override readonly code = "invalid_signature";

  constructor() {
    super("the signed URL is invalid");
  }
}

export class SignedUrlExpiredError extends ForbiddenError {
  override readonly code = "signed_url_expired";

  constructor(expiredAt: Date) {
    super("the signed URL has expired", { expiredAt: expiredAt.toISOString() });
  }
}

export class UnauthorizedError extends DomainError {
  readonly code = "unauthorized";
  readonly httpStatus = 401;
}

export class QuotaExceededError extends DomainError {
  readonly code = "quota_exceeded";
  readonly httpStatus = 422;

  constructor(requestedBytes: number) {
    super(`storing ${requestedBytes} more bytes would exceed the tenant's quota`, {
      requestedBytes: requestedBytes,
    });
  }
}

export class PayloadTooLargeError extends DomainError {
  readonly code = "payload_too_large";
  readonly httpStatus = 413;

  constructor(limitBytes: number, message?: string) {
    super(message ?? `the body exceeds the limit of ${limitBytes} bytes`, {
      limitBytes: limitBytes,
    });
  }
}

/** The file exists but cannot be downloaded: it is waiting for its scan or was quarantined. */
export class FileNotAvailableError extends DomainError {
  readonly code = "file_not_available";
  readonly httpStatus = 409;

  constructor(fileId: string, status: string) {
    super(`file ${fileId} is not available for download (${status})`, {
      fileId,
      status,
    });
  }
}

/** A resumable chunk did not start at the session's current offset. */
export class UploadOffsetMismatchError extends DomainError {
  readonly code = "offset_mismatch";
  readonly httpStatus = 409;
  readonly offset: number;

  constructor(expectedOffset: number, receivedOffset: number) {
    super(`the upload is at offset ${expectedOffset}, the chunk starts at ${receivedOffset}`, {
      offset: expectedOffset,
      receivedOffset: receivedOffset,
    });
    this.offset = expectedOffset;
  }
}

/**
 * The storage backend failed. `storageCode` is the backend's own code (an S3 error code such as
 * `NoSuchKey`, or the same names for the local driver) when there is one.
 */
export class StorageError extends DomainError {
  readonly code = "storage_error";
  readonly httpStatus = 502;
  readonly storageCode: string | undefined;

  constructor(message: string, options: { storageCode?: string; cause?: unknown } = {}) {
    super(
      message,
      options.storageCode === undefined ? undefined : { storageCode: options.storageCode },
      { cause: options.cause },
    );
    this.storageCode = options.storageCode;
  }

  get isNotFound(): boolean {
    return this.storageCode === NO_SUCH_KEY;
  }

  static notFound(key: string): StorageError {
    return new StorageError(`storage object ${key} does not exist`, { storageCode: NO_SUCH_KEY });
  }
}

export const NO_SUCH_KEY = "NoSuchKey";

export function isStorageNotFound(err: unknown): boolean {
  return err instanceof StorageError && err.isNotFound;
}
