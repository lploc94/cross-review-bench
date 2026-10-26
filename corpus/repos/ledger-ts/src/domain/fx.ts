import { exponentOf, type CurrencyCode } from "./currency.js";
import { ValidationError } from "./errors.js";
import { divideRoundHalfEven, pow10 } from "./money.js";

/**
 * Exchange rates are scaled integers: a rate_scaled of 108_500_000 means 1.085 units of the quote
 * currency per unit of the base currency. Eight decimal places cover every published rate.
 */
export const RATE_SCALE_DIGITS = 8;
export const RATE_SCALE = 10n ** BigInt(RATE_SCALE_DIGITS);

const RATE_PATTERN = /^(\d+)(?:\.(\d+))?$/;

export interface FxRate {
  readonly base: CurrencyCode;
  readonly quote: CurrencyCode;
  readonly rateScaled: bigint;
  readonly effectiveAt: Date;
}

/** The rate a currency has against itself. */
export const IDENTITY_RATE_SCALED = RATE_SCALE;

/**
 * Convert `amountMinor` of `from` into minor units of `to` at `rateScaled` (units of `to` per
 * unit of `from`, scaled by RATE_SCALE). Bigint arithmetic only: the exponent difference between
 * the currencies is folded into one fraction and rounded once, half to even.
 *
 *   result = amountMinor × rateScaled × 10^exp(to) / (RATE_SCALE × 10^exp(from))
 */
export function convert(
  amountMinor: bigint,
  from: CurrencyCode,
  to: CurrencyCode,
  rateScaled: bigint,
): bigint {
  if (rateScaled <= 0n) {
    throw new RangeError(`rate must be positive, got ${rateScaled}`);
  }
  const numerator = amountMinor * rateScaled * pow10(exponentOf(to));
  const denominator = RATE_SCALE * pow10(exponentOf(from));
  return divideRoundHalfEven(numerator, denominator);
}

/** Parse a decimal rate ("1.085") into its scaled integer form. */
export function parseRate(input: string): bigint {
  const match = RATE_PATTERN.exec(input.trim());
  if (!match) {
    throw new ValidationError(`invalid rate ${JSON.stringify(input)}`);
  }
  const [, whole = "0", rawFraction = ""] = match;
  const fraction = rawFraction.replace(/0+$/, "");
  if (fraction.length > RATE_SCALE_DIGITS) {
    throw new ValidationError(`rate ${input} has more than ${RATE_SCALE_DIGITS} decimal places`);
  }
  const scaled = BigInt(whole) * RATE_SCALE + BigInt(fraction.padEnd(RATE_SCALE_DIGITS, "0"));
  if (scaled <= 0n) {
    throw new ValidationError("rate must be positive");
  }
  return scaled;
}

/** Format a scaled rate with all eight decimal places: 108_500_000n → "1.08500000". */
export function formatRate(rateScaled: bigint): string {
  const digits = rateScaled.toString().padStart(RATE_SCALE_DIGITS + 1, "0");
  return `${digits.slice(0, -RATE_SCALE_DIGITS)}.${digits.slice(-RATE_SCALE_DIGITS)}`;
}
