import { describe, expect, it } from "vitest";
import {
  gifDimensions,
  jpegDimensions,
  pngDimensions,
  readImageDimensions,
} from "../../src/domain/imageMeta.js";
import { gif, jpeg, png, webp } from "../helpers/images.js";

describe("image dimensions", () => {
  it("reads PNG dimensions from IHDR", () => {
    expect(pngDimensions(png(37, 12))).toEqual({ kind: "dimensions", width: 37, height: 12 });
  });

  it("reads GIF dimensions from the logical screen descriptor", () => {
    expect(gifDimensions(gif(640, 480))).toEqual({ kind: "dimensions", width: 640, height: 480 });
  });

  it("reads baseline and progressive JPEG frame headers", () => {
    expect(jpegDimensions(jpeg(800, 600))).toEqual({ kind: "dimensions", width: 800, height: 600 });
    expect(jpegDimensions(jpeg(31, 7, { sofMarker: 0xc2 }))).toEqual({
      kind: "dimensions",
      width: 31,
      height: 7,
    });
  });

  it("skips DHT, which shares the SOF marker range, instead of reading it as a frame", () => {
    expect(jpegDimensions(jpeg(120, 90, { huffmanTableFirst: true }))).toEqual({
      kind: "dimensions",
      width: 120,
      height: 90,
    });
  });

  it("walks past large metadata segments and reports when it needs more bytes", () => {
    const file = jpeg(1024, 768, { metadataBytes: 20_000 });
    expect(jpegDimensions(file.subarray(0, 4096))).toEqual({ kind: "truncated" });
    expect(jpegDimensions(file)).toEqual({ kind: "dimensions", width: 1024, height: 768 });
  });

  it("refuses zero or out-of-range dimensions and malformed headers", () => {
    expect(pngDimensions(png(0, 5))).toEqual({ kind: "unknown" });
    const huge = png(1, 1);
    huge.writeUInt32BE(0x80000000, 16);
    expect(pngDimensions(huge)).toEqual({ kind: "unknown" });
    expect(jpegDimensions(Buffer.from([0xff, 0xd8, 0x00, 0x00]))).toEqual({ kind: "unknown" });
    // Start of scan before any frame header.
    expect(jpegDimensions(Buffer.from([0xff, 0xd8, 0xff, 0xda, 0x00, 0x02]))).toEqual({ kind: "unknown" });
  });

  it("does not read dimensions for other types, WebP included", () => {
    expect(readImageDimensions(webp(), "image/webp")).toEqual({ kind: "unknown" });
    expect(readImageDimensions(png(3, 3), "application/octet-stream")).toEqual({ kind: "unknown" });
  });
});
