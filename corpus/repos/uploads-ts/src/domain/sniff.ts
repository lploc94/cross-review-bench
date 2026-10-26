/**
 * Content sniffing: the stored content type of a file comes from its first bytes, never from what
 * the uploader declared. Unknown content is `application/octet-stream`, which browsers will not
 * render.
 */
export const SNIFF_BYTES = 4096;
export const OCTET_STREAM = "application/octet-stream";
export const TEXT_PLAIN = "text/plain; charset=utf-8";

interface Signature {
  readonly type: string;
  matches(head: Buffer): boolean;
}

function bytesAt(head: Buffer, offset: number, expected: readonly number[] | string): boolean {
  const bytes = typeof expected === "string" ? Buffer.from(expected, "latin1") : expected;
  if (head.length < offset + bytes.length) return false;
  for (let i = 0; i < bytes.length; i++) {
    if (head[offset + i] !== bytes[i]) return false;
  }
  return true;
}

const SIGNATURES: readonly Signature[] = [
  {
    type: "image/png",
    matches: (head) => bytesAt(head, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  },
  { type: "image/jpeg", matches: (head) => bytesAt(head, 0, [0xff, 0xd8, 0xff]) },
  {
    type: "image/gif",
    matches: (head) => bytesAt(head, 0, "GIF87a") || bytesAt(head, 0, "GIF89a"),
  },
  // RIFF is a container for many formats (WAV, AVI, …); only RIFF/WEBP is an image.
  {
    type: "image/webp",
    matches: (head) => bytesAt(head, 0, "RIFF") && bytesAt(head, 8, "WEBP"),
  },
  { type: "application/pdf", matches: (head) => bytesAt(head, 0, "%PDF-") },
  {
    type: "application/zip",
    // Local file header, empty archive (end of central directory), spanned archive marker.
    matches: (head) =>
      bytesAt(head, 0, [0x50, 0x4b, 0x03, 0x04]) ||
      bytesAt(head, 0, [0x50, 0x4b, 0x05, 0x06]) ||
      bytesAt(head, 0, [0x50, 0x4b, 0x07, 0x08]),
  },
  { type: "application/gzip", matches: (head) => bytesAt(head, 0, [0x1f, 0x8b, 0x08]) },
];

const UTF8_BOM = [0xef, 0xbb, 0xbf];
// Tab, line feed, form feed and carriage return are the only control bytes plain text may hold.
const TEXT_CONTROLS = new Set([0x09, 0x0a, 0x0c, 0x0d]);

/** Bytes a UTF-8 lead byte announces, or 0 for a continuation or invalid byte. */
function sequenceLength(lead: number): number {
  if (lead < 0x80) return 1;
  if (lead >= 0xc2 && lead <= 0xdf) return 2;
  if (lead >= 0xe0 && lead <= 0xef) return 3;
  if (lead >= 0xf0 && lead <= 0xf4) return 4;
  return 0;
}

/**
 * `bytes` without a multi-byte sequence cut off at its end: a 4 KiB head of a larger file can end
 * in the middle of a character.
 */
function withoutTruncatedTail(bytes: Buffer): Buffer {
  for (let back = 1; back <= 3 && back <= bytes.length; back++) {
    const byte = bytes[bytes.length - back] ?? 0;
    if ((byte & 0xc0) !== 0x80) {
      const needed = sequenceLength(byte);
      return needed > back ? bytes.subarray(0, bytes.length - back) : bytes;
    }
  }
  return bytes;
}

const utf8 = new TextDecoder("utf-8", { fatal: true });

/** Plain-text heuristic: valid UTF-8 (BOM allowed) without NUL or control bytes besides whitespace. */
export function looksLikeText(head: Buffer, complete: boolean): boolean {
  let bytes = bytesAt(head, 0, UTF8_BOM) ? head.subarray(UTF8_BOM.length) : head;
  if (bytes.length === 0) return false;
  for (const byte of bytes) {
    if ((byte < 0x20 && !TEXT_CONTROLS.has(byte)) || byte === 0x7f) return false;
  }
  if (!complete) bytes = withoutTruncatedTail(bytes);
  try {
    utf8.decode(bytes);
    return true;
  } catch {
    return false;
  }
}

/**
 * The content type of a file from its first bytes. `complete` says whether `head` is the whole
 * file (it was shorter than SNIFF_BYTES) or only its beginning.
 */
export function sniffContentType(head: Buffer, options: { complete: boolean }): string {
  for (const signature of SIGNATURES) {
    if (signature.matches(head)) return signature.type;
  }
  return looksLikeText(head, options.complete) ? TEXT_PLAIN : OCTET_STREAM;
}

const MEDIA_TYPE = /^([a-z0-9][a-z0-9!#$&^_.+-]{0,126})\/([a-z0-9][a-z0-9!#$&^_.+-]{0,126})$/;

/**
 * A client's declared media type reduced to `type/subtype` in lowercase (parameters dropped), or
 * null when it is not a syntactically valid media type.
 */
export function normalizeDeclaredType(value: string | undefined): string | null {
  if (value === undefined) return null;
  const essence = (value.split(";")[0] ?? "").trim().toLowerCase();
  return MEDIA_TYPE.test(essence) ? essence : null;
}
