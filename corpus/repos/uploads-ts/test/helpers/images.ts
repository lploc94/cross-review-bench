import { crc32, deflateSync } from "node:zlib";

/**
 * Small image files built in code, byte by byte, for the sniffing and dimension tests. They are
 * structurally valid headers (and for PNG a decodable image), not photographs.
 */

function u16be(value: number): Buffer {
  const buffer = Buffer.alloc(2);
  buffer.writeUInt16BE(value);
  return buffer;
}

function u32be(value: number): Buffer {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32BE(value);
  return buffer;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const typeBytes = Buffer.from(type, "latin1");
  const crc = crc32(Buffer.concat([typeBytes, data]));
  return Buffer.concat([u32be(data.length), typeBytes, data, u32be(crc)]);
}

/** An RGB PNG of a solid colour. */
export function png(width: number, height: number): Buffer {
  const header = Buffer.concat([u32be(width), u32be(height), Buffer.from([8, 2, 0, 0, 0])]);
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3, 0x7f)]);
  const pixels = deflateSync(Buffer.concat(Array.from({ length: height }, () => row)));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", pixels),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

/** A GIF89a with the given logical screen size and no frames. */
export function gif(width: number, height: number): Buffer {
  const screen = Buffer.alloc(7);
  screen.writeUInt16LE(width, 0);
  screen.writeUInt16LE(height, 2);
  return Buffer.concat([Buffer.from("GIF89a", "latin1"), screen, Buffer.from([0x3b])]);
}

function jpegSegment(marker: number, payload: Buffer): Buffer {
  return Buffer.concat([Buffer.from([0xff, marker]), u16be(payload.length + 2), payload]);
}

export interface JpegOptions {
  /** Bytes of APP1 metadata before the frame header, split into segments of at most 65533. */
  readonly metadataBytes?: number;
  /** The frame header marker: 0xC0 baseline, 0xC2 progressive, … */
  readonly sofMarker?: number;
  /** Put a DHT segment (0xC4, inside the SOF range but not a frame) before the frame header. */
  readonly huffmanTableFirst?: boolean;
}

/** The marker structure of a JPEG: SOI, APP0, optional metadata, SOF, SOS, EOI. */
export function jpeg(width: number, height: number, options: JpegOptions = {}): Buffer {
  const parts: Buffer[] = [Buffer.from([0xff, 0xd8])];
  parts.push(jpegSegment(0xe0, Buffer.from("JFIF\0\x01\x02\0\0\x01\0\x01\0\0", "latin1")));
  let metadata = options.metadataBytes ?? 0;
  while (metadata > 0) {
    const size = Math.min(metadata, 65_533);
    parts.push(jpegSegment(0xe1, Buffer.alloc(size, 0x20)));
    metadata -= size;
  }
  if (options.huffmanTableFirst) {
    // A DHT segment whose bytes 5–8 would read as a 1×1 frame if it were mistaken for one.
    parts.push(jpegSegment(0xc4, Buffer.from([0x00, 0x00, 0x01, 0x00, 0x01, 0, 0, 0, 0, 0, 0, 0, 0])));
  }
  const frame = Buffer.concat([
    Buffer.from([8]),
    u16be(height),
    u16be(width),
    Buffer.from([3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]),
  ]);
  parts.push(jpegSegment(options.sofMarker ?? 0xc0, frame));
  parts.push(jpegSegment(0xda, Buffer.from([3, 1, 0, 2, 0x11, 3, 0x11, 0, 0x3f, 0])));
  parts.push(Buffer.from([0x12, 0x34, 0xff, 0x00, 0x56]));
  parts.push(Buffer.from([0xff, 0xd9]));
  return Buffer.concat(parts);
}

/** A RIFF/WEBP container with a lossy VP8 chunk header. */
export function webp(): Buffer {
  const vp8 = Buffer.concat([Buffer.from("VP8 ", "latin1"), Buffer.from([10, 0, 0, 0]), Buffer.alloc(10)]);
  const size = Buffer.alloc(4);
  size.writeUInt32LE(4 + vp8.length);
  return Buffer.concat([Buffer.from("RIFF", "latin1"), size, Buffer.from("WEBP", "latin1"), vp8]);
}

/** A RIFF container that is not WebP (a WAVE header). */
export function riffWave(): Buffer {
  const size = Buffer.alloc(4);
  size.writeUInt32LE(4);
  return Buffer.concat([Buffer.from("RIFF", "latin1"), size, Buffer.from("WAVEfmt ", "latin1")]);
}

export function pdf(): Buffer {
  return Buffer.from("%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n", "latin1");
}

export function zip(): Buffer {
  // An empty archive: just the end-of-central-directory record.
  return Buffer.concat([Buffer.from([0x50, 0x4b, 0x05, 0x06]), Buffer.alloc(18)]);
}
