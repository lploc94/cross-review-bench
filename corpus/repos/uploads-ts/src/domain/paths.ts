import { ValidationError } from "./errors.js";

/**
 * File paths are folder-like names chosen by the tenant (`reports/2025/q1.pdf`). They are only
 * names: storage keys are derived from ids (`storageKeyFor`), so a path never reaches a file
 * system or a bucket.
 */
export const MAX_PATH_BYTES = 1024;
export const MAX_SEGMENT_BYTES = 255;
export const MAX_ORIGINAL_NAME_BYTES = 255;

/**
 * First segments that would collide with the API's own routes under `/v1/files/`: a file at
 * `by-id/…` could never be fetched by its path.
 */
export const RESERVED_FIRST_SEGMENTS = new Set(["by-id"]);

/** C0 controls, DEL and C1 controls. */
export function isControlCharacter(code: number): boolean {
  return code <= 0x1f || (code >= 0x7f && code <= 0x9f);
}

function hasControlCharacter(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    if (isControlCharacter(value.charCodeAt(i))) return true;
  }
  return false;
}

function withoutControlCharacters(value: string): string {
  let out = "";
  for (const char of value) {
    if (!isControlCharacter(char.codePointAt(0) ?? 0)) out += char;
  }
  return out;
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function isUuid(value: string): boolean {
  return UUID.test(value);
}

function utf8Length(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function invalid(message: string, path: string): ValidationError {
  return new ValidationError(`invalid path: ${message}`, { path });
}

/**
 * Validate a path and return its canonical form (Unicode NFC). Rejected: empty paths, a leading
 * `/`, empty, `.` and `..` segments (so also a trailing `/` and `//`), backslashes, control
 * characters, malformed UTF-16, more than 1024 bytes in total or 255 bytes in a segment, and a
 * reserved first segment.
 */
export function normalizePath(input: string): string {
  if (!input.isWellFormed()) {
    throw invalid("contains malformed Unicode", input);
  }
  const path = input.normalize("NFC");
  if (path.length === 0) {
    throw invalid("must not be empty", path);
  }
  if (path.startsWith("/")) {
    throw invalid("must not start with /", path);
  }
  if (path.includes("\\")) {
    throw invalid("must not contain a backslash", path);
  }
  if (hasControlCharacter(path)) {
    throw invalid("must not contain control characters", path);
  }
  if (utf8Length(path) > MAX_PATH_BYTES) {
    throw invalid(`must be at most ${MAX_PATH_BYTES} bytes`, path);
  }
  const segments = path.split("/");
  for (const segment of segments) {
    if (segment === "" || segment === "." || segment === "..") {
      throw invalid("must not contain empty, . or .. segments", path);
    }
    if (utf8Length(segment) > MAX_SEGMENT_BYTES) {
      throw invalid(`segments must be at most ${MAX_SEGMENT_BYTES} bytes`, path);
    }
  }
  if (RESERVED_FIRST_SEGMENTS.has(segments[0] ?? "")) {
    throw invalid(`the first segment ${segments[0]} is reserved`, path);
  }
  return path;
}

/** The last segment of a normalized path. */
export function baseName(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? path : path.slice(slash + 1);
}

/** The storage key of a file. The only place keys are made: never from a user-supplied path. */
export function storageKeyFor(tenantId: string, fileId: string): string {
  if (!isUuid(tenantId) || !isUuid(fileId)) {
    throw new Error(`storage keys are built from ids, got ${tenantId}/${fileId}`);
  }
  return `t/${tenantId}/${fileId}`;
}

/** Cut `value` to at most `maxBytes` of UTF-8 without splitting a character. */
export function truncateUtf8(value: string, maxBytes: number): string {
  if (utf8Length(value) <= maxBytes) return value;
  let out = "";
  let bytes = 0;
  for (const char of value) {
    const size = utf8Length(char);
    if (bytes + size > maxBytes) break;
    out += char;
    bytes += size;
  }
  return out;
}

/**
 * The name recorded as the file's original name: the client's file name without any directory
 * part (browsers on some systems send `C:\Users\…\name.pdf`) or control characters, or the path's
 * last segment when the client sent none.
 */
export function originalNameFrom(clientName: string | undefined, path: string): string {
  const fallback = baseName(path);
  if (clientName === undefined) return fallback;
  const lastSeparator = Math.max(clientName.lastIndexOf("/"), clientName.lastIndexOf("\\"));
  const name = withoutControlCharacters(clientName.slice(lastSeparator + 1))
    .toWellFormed()
    .normalize("NFC")
    .trim();
  if (name === "" || name === "." || name === "..") return fallback;
  return truncateUtf8(name, MAX_ORIGINAL_NAME_BYTES);
}
