import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { isUuid } from "@sync/shared";

/**
 * Device tokens: `sd_<device id>_<secret>`, the secret being 32 random bytes in base64url. Only
 * the hex sha256 of the secret is stored; the device id in the token finds the row, and the
 * hashes are compared in constant time.
 */
const TOKEN_PREFIX = "sd_";
const SECRET_BYTES = 32;
const TOKEN_PATTERN = /^sd_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})_([A-Za-z0-9_-]{43})$/;

export interface IssuedToken {
  /** The full token, shown once to whoever registers the device. */
  readonly token: string;
  readonly tokenHash: string;
}

export interface ParsedToken {
  readonly deviceId: string;
  readonly secret: string;
}

export function hashSecret(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

export function issueToken(deviceId: string): IssuedToken {
  if (!isUuid(deviceId)) throw new RangeError(`invalid device id ${deviceId}`);
  const secret = randomBytes(SECRET_BYTES).toString("base64url");
  return { token: `${TOKEN_PREFIX}${deviceId}_${secret}`, tokenHash: hashSecret(secret) };
}

/** The parts of a well-formed token, or null. */
export function parseToken(token: string): ParsedToken | null {
  const match = TOKEN_PATTERN.exec(token);
  if (!match?.[1] || !match[2] || !isUuid(match[1])) return null;
  return { deviceId: match[1], secret: match[2] };
}

/** Whether `secret` hashes to `storedHash`, compared in constant time. */
export function secretMatches(secret: string, storedHash: string): boolean {
  const actual = Buffer.from(hashSecret(secret), "hex");
  const expected = Buffer.from(storedHash, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
