import { describe, expect, it } from "vitest";
import { contentDisposition } from "../../src/api/contentDisposition.js";

describe("contentDisposition", () => {
  it("quotes a printable ASCII name as is", () => {
    expect(contentDisposition("q1 report (final).pdf")).toBe(
      'attachment; filename="q1 report (final).pdf"',
    );
  });

  it("replaces quotes and backslashes, which would break out of the quoted string", () => {
    expect(contentDisposition('a"b\\c.txt')).toBe('attachment; filename="a_b_c.txt"');
  });

  it("replaces every non-ASCII or control character with one underscore", () => {
    expect(contentDisposition("résumé.pdf")).toBe('attachment; filename="r_sum_.pdf"');
    expect(contentDisposition("🎉.png")).toBe('attachment; filename="_.png"');
    expect(contentDisposition("a\r\nb")).toBe('attachment; filename="a__b"');
  });

  it("names an empty name download", () => {
    expect(contentDisposition("")).toBe('attachment; filename="download"');
  });
});
