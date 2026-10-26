import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { signatureHeader, verifySignature } from "../../src/services/webhookSigner.js";

const SECRET = "whsec_test";
const BODY = JSON.stringify({ id: "1", type: "transfer.posted" });
const NOW = new Date("2030-01-15T10:00:00.000Z");
const T = Math.floor(NOW.getTime() / 1000);

describe("webhook signatures", () => {
  it("sign t.body with HMAC-SHA256", () => {
    const expected = createHmac("sha256", SECRET).update(`${T}.${BODY}`).digest("hex");
    expect(signatureHeader(SECRET, BODY, NOW)).toBe(`t=${T},v1=${expected}`);
  });

  it("verify a signature within the tolerance", () => {
    const header = signatureHeader(SECRET, BODY, NOW);
    const later = new Date(NOW.getTime() + 299_000);
    expect(verifySignature(SECRET, BODY, header, later)).toEqual({ valid: true, timestamp: T });
  });

  it("reject old or future timestamps", () => {
    const header = signatureHeader(SECRET, BODY, NOW);
    expect(verifySignature(SECRET, BODY, header, new Date(NOW.getTime() + 301_000))).toEqual({
      valid: false,
      reason: "timestamp",
    });
    expect(verifySignature(SECRET, BODY, header, new Date(NOW.getTime() - 301_000))).toEqual({
      valid: false,
      reason: "timestamp",
    });
  });

  it("reject a changed body or the wrong secret", () => {
    const header = signatureHeader(SECRET, BODY, NOW);
    expect(verifySignature(SECRET, `${BODY} `, header, NOW)).toMatchObject({ reason: "signature" });
    expect(verifySignature("whsec_other", BODY, header, NOW)).toMatchObject({ reason: "signature" });
  });

  it("accept any of several v1 signatures", () => {
    const good = signatureHeader(SECRET, BODY, NOW).split("v1=")[1];
    const header = `t=${T},v1=${"0".repeat(64)},v1=${good}`;
    expect(verifySignature(SECRET, BODY, header, NOW).valid).toBe(true);
  });

  it("reject malformed headers", () => {
    for (const header of ["", "v1=abc", `t=${T}`, `t=abc,v1=00`, `t=${T},t=${T},v1=00`, "garbage"]) {
      expect(verifySignature(SECRET, BODY, header, NOW)).toEqual({ valid: false, reason: "malformed" });
    }
  });
});
