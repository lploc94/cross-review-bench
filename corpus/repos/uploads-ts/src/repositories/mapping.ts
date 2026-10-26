/** Helpers shared by the row mappers: node-postgres hands int8 columns over as strings. */
export function toSafeInteger(value: string | number, column: string): number {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(number)) {
    throw new Error(`${column} holds ${String(value)}, which is not a safe integer`);
  }
  return number;
}

/** First row of a result, or null. */
export function firstRow<T>(rows: T[]): T | null {
  return rows[0] ?? null;
}

/** First row of a result that must have one (an INSERT … RETURNING, an UPDATE known to match). */
export function requireRow<T>(rows: T[], what: string): T {
  const row = rows[0];
  if (row === undefined) {
    throw new Error(`expected a row from ${what}`);
  }
  return row;
}

export const UNIQUE_VIOLATION = "23505";

export function isUniqueViolation(err: unknown, constraint?: string): boolean {
  if (typeof err !== "object" || err === null || !("code" in err) || err.code !== UNIQUE_VIOLATION) {
    return false;
  }
  return constraint === undefined || ("constraint" in err && err.constraint === constraint);
}
