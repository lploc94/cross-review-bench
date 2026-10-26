import { describe, expect, it } from "vitest";
import {
  generateApiKey,
  hashSecret,
  parseApiKey,
  secretHashesMatch,
} from "../../src/domain/apiKey.js";
import { hasScope, partitionScopes } from "../../src/domain/scopes.js";

describe("API keys", () => {
  it("generates tokens that parse back to their prefix and secret", () => {
    const key = generateApiKey();
    expect(key.token).toMatch(/^lk_[a-z0-9]{8}_[0-9a-f]{64}$/);
    expect(parseApiKey(key.token)).toEqual({ prefix: key.prefix, secret: key.secret });
    expect(key.secretHash).toBe(hashSecret(key.secret));
  });

  it("rejects malformed tokens", () => {
    const { token } = generateApiKey();
    for (const candidate of ["", "lk_short_abc", token.toUpperCase(), `${token}0`, `xx${token.slice(2)}`]) {
      expect(parseApiKey(candidate)).toBeNull();
    }
  });

  it("compares secret hashes", () => {
    const hash = hashSecret("secret");
    expect(secretHashesMatch(hash, hashSecret("secret"))).toBe(true);
    expect(secretHashesMatch(hash, hashSecret("other"))).toBe(false);
    expect(secretHashesMatch(hash, "abcd")).toBe(false);
  });
});

describe("scopes", () => {
  it("match exactly, with no implied scopes", () => {
    expect(hasScope(["accounts:write"], "accounts:write")).toBe(true);
    expect(hasScope(["accounts:write"], "accounts:read")).toBe(false);
    expect(hasScope(["accounts:*"], "accounts:read")).toBe(false);
  });

  it("separate known scopes from unknown names", () => {
    expect(partitionScopes(["fx:read", "fx:write", "fx:read", "admin"])).toEqual({
      valid: ["fx:read"],
      unknown: ["fx:write", "admin"],
    });
  });
});
