/** Helpers shared by the row mappers: node-postgres hands int8 columns over as strings. */
export function toBigInt(value: string | number | bigint): bigint {
  return typeof value === "bigint" ? value : BigInt(value);
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
