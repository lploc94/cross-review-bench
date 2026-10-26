import { describe, expect, it } from "vitest";
import { downloadPayload, UrlSigner } from "../../src/services/urlSigner.js";

const signer = new UrlSigner("a-signing-secret-of-at-least-32-chars");

describe("UrlSigner", () => {
  it("verifies its own signatures and nothing else", () => {
    const payload = downloadPayload("4f2b8c1e-0000-4000-8000-000000000001", 1_900_000_000);
    const sig = signer.sign(payload);
    expect(sig).toMatch(/^[0-9a-f]{64}$/);
    expect(signer.verify(payload, sig)).toBe(true);
    expect(signer.verify(`${payload}0`, sig)).toBe(false);
    expect(signer.verify(payload, sig.toUpperCase())).toBe(false);
    expect(signer.verify(payload, `${sig.slice(0, 62)}zz`)).toBe(false);
    expect(signer.verify(payload, sig.slice(0, 62))).toBe(false);
    expect(new UrlSigner("another-signing-secret-of-32-chars!").verify(payload, sig)).toBe(false);
  });

  it("refuses short secrets", () => {
    expect(() => new UrlSigner("too-short")).toThrow(/at least 32/);
  });
});
