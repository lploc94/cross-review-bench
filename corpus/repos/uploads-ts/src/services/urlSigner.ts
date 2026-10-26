import { createHmac, timingSafeEqual } from "node:crypto";
import type { Clock } from "../infra/clock.js";

/** The current time in whole unix seconds, the unit of signed-URL expiries. */
export function unixNow(clock: Clock): number {
  return Math.floor(clock.now().getTime() / 1000);
}

const SIGNATURE = /^[0-9a-f]{64}$/;

/**
 * HMAC-SHA256 signatures for download links. The payload of a download link is
 * `<file id>.<expiry in unix seconds>`; the signature is its lowercase hex HMAC.
 */
export class UrlSigner {
  private readonly secret: string;

  constructor(secret: string) {
    if (secret.length < 32) {
      throw new Error("the signing secret must be at least 32 characters");
    }
    this.secret = secret;
  }

  sign(payload: string): string {
    return createHmac("sha256", this.secret).update(payload, "utf8").digest("hex");
  }

  /**
   * Whether `signature` is the signature of `payload`. Anything but 64 lowercase hex digits is
   * refused before decoding (Buffer.from would silently drop invalid hex); the comparison itself
   * runs in constant time on two 32-byte buffers.
   */
  verify(payload: string, signature: string): boolean {
    if (!SIGNATURE.test(signature)) return false;
    const expected = Buffer.from(this.sign(payload), "hex");
    const presented = Buffer.from(signature, "hex");
    return expected.length === presented.length && timingSafeEqual(expected, presented);
  }
}

export function downloadPayload(fileId: string, expiresAt: number): string {
  return `${fileId}.${expiresAt}`;
}
