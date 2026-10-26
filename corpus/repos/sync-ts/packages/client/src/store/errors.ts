import { SyncError } from "@sync/shared";

/** The local database holds something this client cannot read. Not retryable. */
export class CorruptStoreError extends SyncError {
  constructor(message: string, options: { cause?: unknown } = {}) {
    super("corrupt_store", message, { cause: options.cause });
  }
}

/** The local database was written by a newer client (its schema version is unknown here). */
export class SchemaVersionError extends SyncError {
  readonly found: number;
  readonly supported: number;

  constructor(found: number, supported: number) {
    super(
      "schema_too_new",
      `the local database has schema version ${found}; this client supports up to ${supported}`,
      { details: { found, supported } },
    );
    this.found = found;
    this.supported = supported;
  }
}

/** Parse a JSON column that must hold an object. */
export function parseJsonObject<T>(text: string, what: string): Record<string, T> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (err) {
    throw new CorruptStoreError(`${what} is not valid JSON`, { cause: err });
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new CorruptStoreError(`${what} is not a JSON object`);
  }
  return value as Record<string, T>;
}
