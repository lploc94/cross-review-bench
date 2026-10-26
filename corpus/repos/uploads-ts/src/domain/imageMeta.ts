import type { ImageDimensions } from "./file.js";

/**
 * Image dimensions read from file headers, without decoding the image. PNG and GIF keep them at
 * fixed offsets near the start; JPEG keeps them in the first frame header (SOFn), which may follow
 * large metadata segments, so its header is scanned segment by segment.
 */
export type ImageMetaResult =
  | { readonly kind: "dimensions"; readonly width: number; readonly height: number }
  /** Not a format whose dimensions are read here, or a malformed header. */
  | { readonly kind: "unknown" }
  /** The header continues past the bytes given: read more of the file and try again. */
  | { readonly kind: "truncated" };

/** How much of a JPEG file is read, at most, while looking for its frame header. */
export const JPEG_SCAN_LIMIT = 64 * 1024;

/** Dimensions are stored as Postgres integers. */
const MAX_DIMENSION = 2_147_483_647;

const UNKNOWN: ImageMetaResult = { kind: "unknown" };
const TRUNCATED: ImageMetaResult = { kind: "truncated" };

function dimensions(width: number, height: number): ImageMetaResult {
  if (width < 1 || height < 1 || width > MAX_DIMENSION || height > MAX_DIMENSION) return UNKNOWN;
  return { kind: "dimensions", width, height };
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** PNG: the IHDR chunk must come first; width and height are big-endian u32 at bytes 16 and 20. */
export function pngDimensions(buf: Buffer): ImageMetaResult {
  if (buf.length < 24) {
    return PNG_SIGNATURE.subarray(0, buf.length).equals(buf) ? TRUNCATED : UNKNOWN;
  }
  if (!buf.subarray(0, 8).equals(PNG_SIGNATURE)) return UNKNOWN;
  if (buf.readUInt32BE(8) !== 13 || buf.toString("latin1", 12, 16) !== "IHDR") return UNKNOWN;
  return dimensions(buf.readUInt32BE(16), buf.readUInt32BE(20));
}

/** GIF: the logical screen descriptor follows the 6-byte signature, little-endian u16 each. */
export function gifDimensions(buf: Buffer): ImageMetaResult {
  if (buf.length < 10) return TRUNCATED;
  const signature = buf.toString("latin1", 0, 6);
  if (signature !== "GIF87a" && signature !== "GIF89a") return UNKNOWN;
  return dimensions(buf.readUInt16LE(6), buf.readUInt16LE(8));
}

/** SOF0–SOF15 carry the frame size, except DHT (C4), JPG (C8) and DAC (CC), which share the range. */
function isStartOfFrame(marker: number): boolean {
  return marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
}

/** Markers without a length field: TEM and the restart markers RST0–RST7. */
function isStandalone(marker: number): boolean {
  return marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7);
}

/**
 * JPEG: walk the segments after SOI, skipping each by its length, until a frame header. Reaching
 * the start of scan or the end of the image first means the file has no usable frame header.
 */
export function jpegDimensions(buf: Buffer): ImageMetaResult {
  if (buf.length < 2) return TRUNCATED;
  if (buf[0] !== 0xff || buf[1] !== 0xd8) return UNKNOWN;
  let i = 2;
  for (;;) {
    if (i >= buf.length) return TRUNCATED;
    if (buf[i] !== 0xff) return UNKNOWN;
    // Any number of 0xFF fill bytes may precede a marker.
    while (i < buf.length && buf[i] === 0xff) i++;
    if (i >= buf.length) return TRUNCATED;
    const marker = buf[i] ?? 0;
    i++;
    if (isStandalone(marker)) continue;
    if (marker === 0x00 || marker === 0xd8 || marker === 0xd9 || marker === 0xda) return UNKNOWN;
    if (i + 2 > buf.length) return TRUNCATED;
    const length = buf.readUInt16BE(i);
    if (length < 2) return UNKNOWN;
    if (isStartOfFrame(marker)) {
      // length (2), sample precision (1), number of lines (2), samples per line (2)
      if (length < 7) return UNKNOWN;
      if (i + 7 > buf.length) return TRUNCATED;
      return dimensions(buf.readUInt16BE(i + 5), buf.readUInt16BE(i + 3));
    }
    i += length;
  }
}

/** Dimensions of an image of the given sniffed content type, read from `buf` (its first bytes). */
export function readImageDimensions(buf: Buffer, contentType: string): ImageMetaResult {
  switch (contentType) {
    case "image/png":
      return pngDimensions(buf);
    case "image/gif":
      return gifDimensions(buf);
    case "image/jpeg":
      return jpegDimensions(buf);
    default:
      return UNKNOWN;
  }
}

export function toImageDimensions(result: ImageMetaResult): ImageDimensions | null {
  return result.kind === "dimensions" ? { width: result.width, height: result.height } : null;
}
