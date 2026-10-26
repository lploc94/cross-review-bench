import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * API keys look like `up_<prefix>_<secret>`: an 8-character lowercase prefix that identifies the
 * key row and a 64-character hex secret of which only the sha256 is stored.
 */
export const API_KEY_PREFIX_LENGTH = 8;
export const API_KEY_SECRET_BYTES = 32;

const TOKEN_PATTERN = /^up_([a-z0-9]{8})_([0-9a-f]{64})$/;
const PREFIX_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

export interface ParsedApiKey {
  readonly prefix: string;
  readonly secret: string;
}

export interface GeneratedApiKey extends ParsedApiKey {
  readonly token: string;
  readonly secretHash: string;
}

export function parseApiKey(token: string): ParsedApiKey | null {
  const match = TOKEN_PATTERN.exec(token);
  if (!match) return null;
  const [, prefix, secret] = match;
  if (prefix === undefined || secret === undefined) return null;
  return { prefix, secret };
}

export function hashSecret(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

/** Constant-time comparison of two sha256 hex digests. */
export function secretHashesMatch(expectedHex: string, actualHex: string): boolean {
  const expected = Buffer.from(expectedHex, "hex");
  const actual = Buffer.from(actualHex, "hex");
  if (expected.length !== actual.length || expected.length === 0) {
    return false;
  }
  return timingSafeEqual(expected, actual);
}

function randomPrefix(): string {
  // 36 does not divide 256: draw bytes and reject those that would bias the alphabet.
  const limit = 256 - (256 % PREFIX_ALPHABET.length);
  let prefix = "";
  while (prefix.length < API_KEY_PREFIX_LENGTH) {
    for (const byte of randomBytes(API_KEY_PREFIX_LENGTH * 2)) {
      if (byte < limit && prefix.length < API_KEY_PREFIX_LENGTH) {
        prefix += PREFIX_ALPHABET[byte % PREFIX_ALPHABET.length];
      }
    }
  }
  return prefix;
}

export function generateApiKey(): GeneratedApiKey {
  const prefix = randomPrefix();
  const secret = randomBytes(API_KEY_SECRET_BYTES).toString("hex");
  return { prefix, secret, token: `up_${prefix}_${secret}`, secretHash: hashSecret(secret) };
}

export interface ApiKeyRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly name: string;
  readonly prefix: string;
  readonly secretHash: string;
  readonly scopes: readonly string[];
  readonly createdAt: Date;
  readonly revokedAt: Date | null;
}
