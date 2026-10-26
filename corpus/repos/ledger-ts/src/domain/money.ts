import { exponentOf, type CurrencyCode } from "./currency.js";
import { CurrencyMismatchError, ValidationError } from "./errors.js";

/**
 * Amounts are integers of the currency's minor unit (cents for USD, yen for JPY, fils for KWD).
 * They are bigint everywhere in the code and decimal integer strings on the wire.
 */
export interface Money {
  readonly amountMinor: bigint;
  readonly currency: CurrencyCode;
}

/** Largest amount a single transfer or hold may move (int8 leaves room for balances above it). */
export const MAX_AMOUNT_MINOR = 10n ** 15n;

const INT8_MAX = 2n ** 63n - 1n;
const INT8_MIN = -(2n ** 63n);
const DECIMAL_PATTERN = /^(-)?(\d+)(?:\.(\d+))?$/;
const MINOR_PATTERN = /^-?\d+$/;

export function money(amountMinor: bigint, currency: CurrencyCode): Money {
  return { amountMinor, currency };
}

export function pow10(exponent: number): bigint {
  if (!Number.isInteger(exponent) || exponent < 0) {
    throw new RangeError(`exponent must be a non-negative integer, got ${exponent}`);
  }
  return 10n ** BigInt(exponent);
}

function assertSameCurrency(a: Money, b: Money): void {
  if (a.currency !== b.currency) {
    throw new CurrencyMismatchError(a.currency, b.currency);
  }
}

export function add(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return money(a.amountMinor + b.amountMinor, a.currency);
}

export function sub(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return money(a.amountMinor - b.amountMinor, a.currency);
}

/** -1, 0 or 1, like a sort comparator. */
export function compare(a: Money, b: Money): -1 | 0 | 1 {
  assertSameCurrency(a, b);
  if (a.amountMinor < b.amountMinor) return -1;
  if (a.amountMinor > b.amountMinor) return 1;
  return 0;
}

/**
 * Parse a decimal amount in major units ("12.34") into minor units of `currency` (1234 for USD).
 * Trailing zeros beyond the currency's exponent are accepted ("12.340"); any other extra precision
 * is rejected rather than rounded, so no value is silently changed.
 */
export function parseDecimal(input: string, currency: CurrencyCode): bigint {
  const match = DECIMAL_PATTERN.exec(input.trim());
  if (!match) {
    throw new ValidationError(`invalid decimal amount ${JSON.stringify(input)}`);
  }
  const [, sign, whole = "0", rawFraction = ""] = match;
  const exponent = exponentOf(currency);
  const fraction = rawFraction.replace(/0+$/, "");
  if (fraction.length > exponent) {
    throw new ValidationError(
      `amount ${input} has more than ${exponent} decimal places for ${currency}`,
    );
  }
  const minor = BigInt(whole) * pow10(exponent) + BigInt(fraction.padEnd(exponent, "0") || "0");
  return sign ? -minor : minor;
}

/** Format minor units as a decimal string in major units: 1234 USD → "12.34", -5 USD → "-0.05". */
export function formatMinor(amountMinor: bigint, currency: CurrencyCode): string {
  const exponent = exponentOf(currency);
  const negative = amountMinor < 0n;
  const digits = (negative ? -amountMinor : amountMinor).toString();
  if (exponent === 0) {
    return `${negative ? "-" : ""}${digits}`;
  }
  const padded = digits.padStart(exponent + 1, "0");
  const whole = padded.slice(0, -exponent);
  const fraction = padded.slice(-exponent);
  return `${negative ? "-" : ""}${whole}.${fraction}`;
}

/** Parse a decimal integer string of minor units as stored or sent on the wire. */
export function parseMinor(value: string): bigint {
  if (!MINOR_PATTERN.test(value)) {
    throw new ValidationError(`invalid minor-unit amount ${JSON.stringify(value)}`);
  }
  const parsed = BigInt(value);
  if (parsed > INT8_MAX || parsed < INT8_MIN) {
    throw new ValidationError(`amount ${value} is out of range`);
  }
  return parsed;
}

/**
 * Integer division rounding to the nearest integer, ties to the even neighbour (banker's
 * rounding). Signs are handled symmetrically: the magnitude is rounded, then the sign applied,
 * so divideRoundHalfEven(-5n, 2n) is -2n and divideRoundHalfEven(-7n, 2n) is -4n.
 */
export function divideRoundHalfEven(numerator: bigint, denominator: bigint): bigint {
  if (denominator === 0n) {
    throw new RangeError("division by zero");
  }
  const negative = numerator < 0n !== denominator < 0n;
  const n = numerator < 0n ? -numerator : numerator;
  const d = denominator < 0n ? -denominator : denominator;
  let quotient = n / d;
  const twiceRemainder = (n % d) * 2n;
  if (twiceRemainder > d || (twiceRemainder === d && quotient % 2n === 1n)) {
    quotient += 1n;
  }
  return negative ? -quotient : quotient;
}
