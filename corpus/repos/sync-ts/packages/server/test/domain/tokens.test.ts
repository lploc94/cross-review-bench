import { describe, expect, it } from "vitest";
import { hashSecret, issueToken, parseToken, secretMatches } from "../../src/domain/tokens.js";

const DEVICE = "6f1c2d3e-4a5b-4c6d-8e7f-0a1b2c3d4e5f";

describe("device tokens", () => {
  it("carry the device id and a secret whose hash is stored", () => {
    const issued = issueToken(DEVICE);
    const parsed = parseToken(issued.token);
    expect(parsed?.deviceId).toBe(DEVICE);
    expect(parsed && hashSecret(parsed.secret)).toBe(issued.tokenHash);
  });

  it("are different every time", () => {
    expect(issueToken(DEVICE).token).not.toBe(issueToken(DEVICE).token);
  });

  it("match only their own secret", () => {
    const issued = issueToken(DEVICE);
    const parsed = parseToken(issued.token);
    expect(parsed && secretMatches(parsed.secret, issued.tokenHash)).toBe(true);
    const other = parseToken(issueToken(DEVICE).token);
    expect(other && secretMatches(other.secret, issued.tokenHash)).toBe(false);
  });

  it("reject malformed tokens", () => {
    const valid = issueToken(DEVICE).token;
    expect(parseToken("")).toBeNull();
    expect(parseToken(valid.slice(0, -1))).toBeNull();
    expect(parseToken(`${valid}x`)).toBeNull();
    expect(parseToken(valid.replace("sd_", "xx_"))).toBeNull();
    expect(parseToken(valid.toUpperCase())).toBeNull();
  });

  it("do not match a stored hash of another length", () => {
    expect(secretMatches("secret", "abcd")).toBe(false);
  });
});
