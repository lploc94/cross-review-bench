import { describe, expect, it } from "vitest";
import {
  looksLikeText,
  normalizeDeclaredType,
  OCTET_STREAM,
  sniffContentType,
  TEXT_PLAIN,
} from "../../src/domain/sniff.js";
import { gif, jpeg, pdf, png, riffWave, webp, zip } from "../helpers/images.js";
import { gzipSync } from "node:zlib";

const complete = { complete: true };

describe("sniffContentType", () => {
  it.each([
    ["PNG", png(2, 2), "image/png"],
    ["JPEG", jpeg(4, 3), "image/jpeg"],
    ["GIF", gif(5, 5), "image/gif"],
    ["WebP", webp(), "image/webp"],
    ["PDF", pdf(), "application/pdf"],
    ["ZIP", zip(), "application/zip"],
    ["gzip", gzipSync(Buffer.from("compressed text")), "application/gzip"],
  ])("recognises %s by its magic bytes", (_name, bytes, type) => {
    expect(sniffContentType(bytes, complete)).toBe(type);
  });

  it("only treats RIFF containers with the WEBP form type as images", () => {
    expect(sniffContentType(riffWave(), complete)).toBe(OCTET_STREAM);
  });

  it("ignores the declared type: HTML bytes are plain text, never text/html", () => {
    expect(sniffContentType(Buffer.from("<html><script>alert(1)</script></html>"), complete)).toBe(
      TEXT_PLAIN,
    );
  });

  it("falls back to application/octet-stream", () => {
    expect(sniffContentType(Buffer.from([0x00, 0x01, 0x02, 0xff]), complete)).toBe(OCTET_STREAM);
    expect(sniffContentType(Buffer.alloc(0), complete)).toBe(OCTET_STREAM);
  });
});

describe("looksLikeText", () => {
  it("accepts UTF-8 with a BOM and common whitespace", () => {
    expect(looksLikeText(Buffer.from("\ufeffline one\r\n\tline two\n"), true)).toBe(true);
    expect(looksLikeText(Buffer.from("Grüße, 世界"), true)).toBe(true);
  });

  it("rejects NUL bytes, other control bytes and invalid UTF-8", () => {
    expect(looksLikeText(Buffer.from("abc\u0000def"), true)).toBe(false);
    expect(looksLikeText(Buffer.from("bell\u0007"), true)).toBe(false);
    expect(looksLikeText(Buffer.from([0x61, 0xc3, 0x28]), true)).toBe(false);
  });

  it("forgives a character cut off at the end of a partial head only", () => {
    const text = Buffer.from("price: 5€");
    const cut = text.subarray(0, text.length - 1);
    expect(looksLikeText(cut, false)).toBe(true);
    expect(looksLikeText(cut, true)).toBe(false);
  });
});

describe("normalizeDeclaredType", () => {
  it("keeps the essence of a valid media type in lowercase", () => {
    expect(normalizeDeclaredType("Text/Plain; charset=UTF-8")).toBe("text/plain");
    expect(normalizeDeclaredType("application/vnd.ms-excel")).toBe("application/vnd.ms-excel");
  });

  it("drops malformed values", () => {
    expect(normalizeDeclaredType(undefined)).toBeNull();
    expect(normalizeDeclaredType("not a type")).toBeNull();
    expect(normalizeDeclaredType("text/")).toBeNull();
  });
});
