import { SyncError } from "@sync/shared";

/**
 * Whether a failed request may succeed when repeated: server errors are, client errors (4xx)
 * are not, since the same request will be refused again.
 */
export function isRetryableStatus(status: number): boolean {
  return status >= 500;
}

/** The request did not complete: no connection, a reset, a timeout. The server may or may not
 * have processed it, so it must be safe to send again. */
export class NetworkError extends SyncError {
  constructor(message: string, options: { cause?: unknown } = {}) {
    super("network_error", message, { retryable: true, cause: options.cause });
  }
}

/** The server answered with an error status. `code` is the server's error code when it sent one. */
export class HttpError extends SyncError {
  readonly status: number;

  constructor(status: number, code: string, message: string, details?: Readonly<Record<string, unknown>>) {
    super(code, message, { retryable: isRetryableStatus(status), details: { ...details, status } });
    this.status = status;
  }
}

/** The server speaks another protocol version (426): this client must be upgraded. */
export class ProtocolMismatchError extends HttpError {
  readonly serverVersion: number | null;

  constructor(message: string, serverVersion: number | null) {
    super(426, "protocol_mismatch", message, { serverVersion });
    this.serverVersion = serverVersion;
  }
}

/** A successful answer that does not follow the protocol. Not retryable. */
export class InvalidResponseError extends SyncError {
  constructor(message: string, options: { cause?: unknown; details?: Readonly<Record<string, unknown>> } = {}) {
    super("invalid_response", message, options);
  }
}
