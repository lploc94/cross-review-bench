import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Webhook signatures. Each delivery carries
 *
 *   X-Ledger-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<body>">
 *
 * keyed with the endpoint's secret. Receivers recompute the HMAC over the raw body and reject
 * timestamps too far from their own clock, which bounds how long a captured delivery can be
 * replayed.
 */
export const SIGNATURE_HEADER = "x-ledger-signature";
export const DEFAULT_TOLERANCE_SECONDS = 300;

export function computeSignature(secret: string, timestamp: number, body: string): string {
  return createHmac("sha256", secret).update(`${timestamp}.${body}`, "utf8").digest("hex");
}

export function signatureHeader(secret: string, body: string, now: Date): string {
  const timestamp = Math.floor(now.getTime() / 1000);
  return `t=${timestamp},v1=${computeSignature(secret, timestamp, body)}`;
}

interface ParsedHeader {
  readonly timestamp: number;
  readonly signatures: string[];
}

function parseHeader(header: string): ParsedHeader | null {
  let timestamp: number | null = null;
  const signatures: string[] = [];
  for (const part of header.split(",")) {
    const separator = part.indexOf("=");
    if (separator <= 0) return null;
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (name === "t") {
      if (!/^\d{1,12}$/.test(value) || timestamp !== null) return null;
      timestamp = Number(value);
    } else if (name === "v1") {
      signatures.push(value);
    }
    // Other schemes are ignored so that new ones can be added next to v1.
  }
  if (timestamp === null || signatures.length === 0) return null;
  return { timestamp, signatures };
}

export type VerificationResult =
  | { readonly valid: true; readonly timestamp: number }
  | { readonly valid: false; readonly reason: "malformed" | "timestamp" | "signature" };

/**
 * Check a signature header against the raw body. Any v1 entry may match (several are sent
 * while a secret is being rotated); comparisons are constant-time.
 */
export function verifySignature(
  secret: string,
  body: string,
  header: string,
  now: Date,
  toleranceSeconds: number = DEFAULT_TOLERANCE_SECONDS,
): VerificationResult {
  const parsed = parseHeader(header);
  if (!parsed) return { valid: false, reason: "malformed" };

  const nowSeconds = Math.floor(now.getTime() / 1000);
  if (Math.abs(nowSeconds - parsed.timestamp) > toleranceSeconds) {
    return { valid: false, reason: "timestamp" };
  }
  const expected = Buffer.from(computeSignature(secret, parsed.timestamp, body), "hex");
  const matches = parsed.signatures.some((signature) => {
    if (!/^[0-9a-f]+$/i.test(signature)) return false;
    const candidate = Buffer.from(signature, "hex");
    return candidate.length === expected.length && timingSafeEqual(candidate, expected);
  });
  return matches ? { valid: true, timestamp: parsed.timestamp } : { valid: false, reason: "signature" };
}
