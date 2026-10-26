/**
 * Supported currencies and their ISO 4217 minor-unit exponents. The `currencies` table is seeded
 * with the same list by migration 0001; a test keeps the two in step.
 */
export interface Currency {
  readonly code: CurrencyCode;
  readonly exponent: number;
  readonly name: string;
}

export const CURRENCY_CODES = ["USD", "EUR", "GBP", "CHF", "JPY", "VND", "KWD", "BHD"] as const;

export type CurrencyCode = (typeof CURRENCY_CODES)[number];

const CURRENCIES: Readonly<Record<CurrencyCode, Currency>> = {
  USD: { code: "USD", exponent: 2, name: "US Dollar" },
  EUR: { code: "EUR", exponent: 2, name: "Euro" },
  GBP: { code: "GBP", exponent: 2, name: "Pound Sterling" },
  CHF: { code: "CHF", exponent: 2, name: "Swiss Franc" },
  JPY: { code: "JPY", exponent: 0, name: "Yen" },
  VND: { code: "VND", exponent: 0, name: "Dong" },
  KWD: { code: "KWD", exponent: 3, name: "Kuwaiti Dinar" },
  BHD: { code: "BHD", exponent: 3, name: "Bahraini Dinar" },
};

export function isCurrencyCode(value: string): value is CurrencyCode {
  return Object.hasOwn(CURRENCIES, value);
}

/** Narrow a code read from storage; an unknown code means the data and the code base disagree. */
export function toCurrencyCode(value: string): CurrencyCode {
  if (!isCurrencyCode(value)) {
    throw new Error(`unsupported currency code ${JSON.stringify(value)}`);
  }
  return value;
}

export function exponentOf(code: CurrencyCode): number {
  return CURRENCIES[code].exponent;
}

export function listCurrencies(): Currency[] {
  return CURRENCY_CODES.map((code) => CURRENCIES[code]);
}
