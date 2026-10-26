import { ValidationError } from "./errors.js";
import { isUuid, MAX_PATH_BYTES } from "./paths.js";

/**
 * Keyset pagination over a tenant's files in (path, id) order. The cursor is the position of the
 * last item of a page, as opaque base64url JSON; clients pass it back as `after`.
 */
export interface FileCursor {
  readonly path: string;
  readonly id: string;
}

// A cursor holds one path (at most 1024 bytes, escaped in JSON) and an id; anything much longer
// was not issued by this service.
export const MAX_CURSOR_LENGTH = 4 * MAX_PATH_BYTES;

export function encodeCursor(cursor: FileCursor): string {
  return Buffer.from(JSON.stringify([cursor.path, cursor.id]), "utf8").toString("base64url");
}

export function decodeCursor(value: string): FileCursor {
  const invalid = () => new ValidationError("invalid cursor", { cursor: value.slice(0, 64) });
  if (value.length === 0 || value.length > MAX_CURSOR_LENGTH || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw invalid();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    throw invalid();
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length !== 2 ||
    typeof parsed[0] !== "string" ||
    typeof parsed[1] !== "string" ||
    parsed[0].length === 0 ||
    !isUuid(parsed[1])
  ) {
    throw invalid();
  }
  return { path: parsed[0], id: parsed[1] };
}

export interface CursorPage<T> {
  readonly items: T[];
  readonly nextCursor: string | null;
}

/**
 * Build a page from rows fetched with `LIMIT limit + 1`: the extra row only tells that another
 * page exists, and the cursor points at the last row returned.
 */
export function toCursorPage<T extends FileCursor>(rows: T[], limit: number): CursorPage<T> {
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const last = items.at(-1);
  return { items, nextCursor: hasMore && last ? encodeCursor(last) : null };
}
