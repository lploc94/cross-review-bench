/**
 * Row mapping helpers. node-postgres returns int8 columns as strings; sequence numbers are
 * converted to numbers only when exact.
 */
export function toSafeInteger(value: string | number, column: string): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(n)) {
    throw new RangeError(`${column} value ${String(value)} is not a safe integer`);
  }
  return n;
}

export function toNullableSafeInteger(value: string | number | null, column: string): number | null {
  return value === null ? null : toSafeInteger(value, column);
}

/** A jsonb object column as a plain record (the schema's CHECK guarantees an object). */
export function toRecord<T>(value: unknown, column: string): Record<string, T> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${column} is not a JSON object`);
  }
  return value as Record<string, T>;
}

/** PostgreSQL error code of a failed query, if it is one. */
export function pgErrorCode(err: unknown): string | undefined {
  if (err instanceof Error && "code" in err && typeof err.code === "string") return err.code;
  return undefined;
}

export const UNIQUE_VIOLATION = "23505";
