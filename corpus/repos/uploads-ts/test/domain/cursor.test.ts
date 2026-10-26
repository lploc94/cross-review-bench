import { describe, expect, it } from "vitest";
import { decodeCursor, encodeCursor, toCursorPage } from "../../src/domain/cursor.js";
import { ValidationError } from "../../src/domain/errors.js";

const id = "0b9d5c3e-7a21-4f6d-8e44-91c2b7a6d5f3";

describe("file cursors", () => {
  it("round-trips a position as opaque base64url", () => {
    const cursor = encodeCursor({ path: "reports/ä/q1.pdf", id });
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeCursor(cursor)).toEqual({ path: "reports/ä/q1.pdf", id });
  });

  it.each([
    ["not base64", "!!!"],
    ["not JSON", Buffer.from("nope").toString("base64url")],
    ["wrong shape", Buffer.from(JSON.stringify({ path: "a", id })).toString("base64url")],
    ["bad id", Buffer.from(JSON.stringify(["a", "123"])).toString("base64url")],
    ["too long", "a".repeat(5000)],
  ])("rejects a cursor that is %s", (_reason, value) => {
    expect(() => decodeCursor(value)).toThrow(ValidationError);
  });

  it("builds pages from limit + 1 rows", () => {
    const rows = [
      { path: "a", id },
      { path: "b", id },
      { path: "c", id },
    ];
    const page = toCursorPage(rows, 2);
    expect(page.items.map((row) => row.path)).toEqual(["a", "b"]);
    expect(decodeCursor(page.nextCursor ?? "")).toEqual({ path: "b", id });
    expect(toCursorPage(rows.slice(0, 2), 2).nextCursor).toBeNull();
  });
});
