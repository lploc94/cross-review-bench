import { describe, expect, it } from "vitest";
import { ValidationError } from "../../src/domain/errors.js";
import {
  MAX_PATH_BYTES,
  normalizePath,
  originalNameFrom,
  storageKeyFor,
  truncateUtf8,
} from "../../src/domain/paths.js";

describe("normalizePath", () => {
  it("accepts folder-like paths and returns them in NFC", () => {
    expect(normalizePath("reports/2025/q1.pdf")).toBe("reports/2025/q1.pdf");
    // "e" + combining acute accent becomes the precomposed character.
    expect(normalizePath("caf\u0065\u0301/menu.txt")).toBe("caf\u00e9/menu.txt");
    expect(normalizePath("notes/with space.txt")).toBe("notes/with space.txt");
  });

  it.each([
    ["", "empty"],
    ["/etc/passwd", "leading slash"],
    ["a//b", "empty segment"],
    ["a/b/", "trailing slash"],
    ["a/./b", "dot segment"],
    ["a/../b", "dot-dot segment"],
    ["..", "only dot-dot"],
    ["a\\b", "backslash"],
    ["a/b\u0000c", "NUL"],
    ["a/b\nc", "newline"],
    ["a/b\u0085c", "C1 control"],
    ["by-id/1234", "reserved first segment"],
    ["bad\ud800half", "lone surrogate"],
  ])("rejects %j (%s)", (input) => {
    expect(() => normalizePath(input)).toThrow(ValidationError);
  });

  it("limits the path to 1024 bytes and segments to 255 bytes of UTF-8", () => {
    const segment = "x".repeat(255);
    const longPath = Array.from({ length: 4 }, () => segment).join("/");
    expect(Buffer.byteLength(longPath)).toBe(1023);
    expect(normalizePath(longPath)).toBe(longPath);
    expect(() => normalizePath(`${longPath}/yy`)).toThrow(/at most 1024 bytes/);
    expect(() => normalizePath("x".repeat(256))).toThrow(/at most 255 bytes/);
    // 128 two-byte characters are 256 bytes although only 128 characters long.
    expect(() => normalizePath("é".repeat(128))).toThrow(/at most 255 bytes/);
    expect(MAX_PATH_BYTES).toBe(1024);
  });

  it("allows by-id as a later segment", () => {
    expect(normalizePath("exports/by-id/list.csv")).toBe("exports/by-id/list.csv");
  });
});

describe("storageKeyFor", () => {
  it("derives the key from the tenant and file ids only", () => {
    const tenant = "6f1c2a7e-0d4b-4e0a-9b51-2f8e6c1d3a90";
    const file = "0b9d5c3e-7a21-4f6d-8e44-91c2b7a6d5f3";
    expect(storageKeyFor(tenant, file)).toBe(`t/${tenant}/${file}`);
  });

  it("refuses anything that is not an id", () => {
    expect(() => storageKeyFor("../other", "0b9d5c3e-7a21-4f6d-8e44-91c2b7a6d5f3")).toThrow();
  });
});

describe("originalNameFrom", () => {
  it("keeps the client's file name without directories or control characters", () => {
    expect(originalNameFrom("C:\\Users\\someone\\plan.pdf", "docs/x.pdf")).toBe("plan.pdf");
    expect(originalNameFrom("../../etc/plan\u0007.pdf", "docs/x.pdf")).toBe("plan.pdf");
  });

  it("falls back to the last path segment", () => {
    expect(originalNameFrom(undefined, "docs/q1.pdf")).toBe("q1.pdf");
    expect(originalNameFrom("  ", "docs/q1.pdf")).toBe("q1.pdf");
    expect(originalNameFrom("dir/", "docs/q1.pdf")).toBe("q1.pdf");
  });

  it("truncates long names on a character boundary", () => {
    const name = originalNameFrom("é".repeat(200), "docs/q1.pdf");
    expect(Buffer.byteLength(name)).toBe(254);
    expect(truncateUtf8("aé", 2)).toBe("a");
  });
});
