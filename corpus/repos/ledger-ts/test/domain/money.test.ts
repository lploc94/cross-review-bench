import { describe, expect, it } from "vitest";
import { CurrencyMismatchError, ValidationError } from "../../src/domain/errors.js";
import {
  add,
  compare,
  divideRoundHalfEven,
  formatMinor,
  money,
  parseDecimal,
  parseMinor,
  sub,
} from "../../src/domain/money.js";

describe("parseDecimal", () => {
  it("converts major units to minor units using the currency exponent", () => {
    expect(parseDecimal("12.34", "USD")).toBe(1234n);
    expect(parseDecimal("12", "USD")).toBe(1200n);
    expect(parseDecimal("1500", "JPY")).toBe(1500n);
    expect(parseDecimal("1.005", "KWD")).toBe(1005n);
    expect(parseDecimal("0.5", "BHD")).toBe(500n);
  });

  it("handles negative amounts", () => {
    expect(parseDecimal("-0.05", "EUR")).toBe(-5n);
  });

  it("accepts trailing zeros beyond the exponent but rejects real extra precision", () => {
    expect(parseDecimal("12.340", "USD")).toBe(1234n);
    expect(parseDecimal("100.0", "JPY")).toBe(100n);
    expect(() => parseDecimal("12.345", "USD")).toThrow(ValidationError);
    expect(() => parseDecimal("1.5", "VND")).toThrow(ValidationError);
  });

  it("rejects input that is not a plain decimal number", () => {
    for (const input of ["", "abc", "1,000.00", "1e3", ".5", "5.", "+5"]) {
      expect(() => parseDecimal(input, "USD")).toThrow(ValidationError);
    }
  });
});

describe("formatMinor", () => {
  it("formats minor units with the currency exponent", () => {
    expect(formatMinor(1234n, "USD")).toBe("12.34");
    expect(formatMinor(5n, "USD")).toBe("0.05");
    expect(formatMinor(-5n, "USD")).toBe("-0.05");
    expect(formatMinor(1500n, "JPY")).toBe("1500");
    expect(formatMinor(1005n, "KWD")).toBe("1.005");
    expect(formatMinor(0n, "BHD")).toBe("0.000");
  });

  it("round-trips through parseDecimal", () => {
    for (const minor of [0n, 1n, 99n, 100n, 123456789n, -42n]) {
      expect(parseDecimal(formatMinor(minor, "KWD"), "KWD")).toBe(minor);
    }
  });
});

describe("arithmetic", () => {
  it("adds, subtracts and compares amounts of one currency", () => {
    const a = money(1050n, "EUR");
    const b = money(25n, "EUR");
    expect(add(a, b)).toEqual(money(1075n, "EUR"));
    expect(sub(b, a)).toEqual(money(-1025n, "EUR"));
    expect(compare(a, b)).toBe(1);
    expect(compare(b, a)).toBe(-1);
    expect(compare(a, money(1050n, "EUR"))).toBe(0);
  });

  it("refuses to mix currencies", () => {
    expect(() => add(money(1n, "USD"), money(1n, "EUR"))).toThrow(CurrencyMismatchError);
    expect(() => compare(money(1n, "JPY"), money(1n, "VND"))).toThrow(CurrencyMismatchError);
  });
});

describe("parseMinor", () => {
  it("parses signed integer strings and rejects anything else", () => {
    expect(parseMinor("1050")).toBe(1050n);
    expect(parseMinor("-3")).toBe(-3n);
    expect(() => parseMinor("10.5")).toThrow(ValidationError);
    expect(() => parseMinor("9223372036854775808")).toThrow(ValidationError);
  });
});

describe("divideRoundHalfEven", () => {
  it("rounds to the nearest integer", () => {
    expect(divideRoundHalfEven(7n, 3n)).toBe(2n);
    expect(divideRoundHalfEven(8n, 3n)).toBe(3n);
    expect(divideRoundHalfEven(10n, 5n)).toBe(2n);
  });

  it("rounds exact halves to the even neighbour", () => {
    expect(divideRoundHalfEven(5n, 2n)).toBe(2n);
    expect(divideRoundHalfEven(7n, 2n)).toBe(4n);
    expect(divideRoundHalfEven(25n, 10n)).toBe(2n);
    expect(divideRoundHalfEven(35n, 10n)).toBe(4n);
  });

  it("is symmetric around zero", () => {
    expect(divideRoundHalfEven(-5n, 2n)).toBe(-2n);
    expect(divideRoundHalfEven(-7n, 2n)).toBe(-4n);
    expect(divideRoundHalfEven(7n, -2n)).toBe(-4n);
    expect(divideRoundHalfEven(-8n, -3n)).toBe(3n);
    expect(divideRoundHalfEven(-1n, 3n)).toBe(0n);
  });

  it("rejects a zero denominator", () => {
    expect(() => divideRoundHalfEven(1n, 0n)).toThrow(RangeError);
  });
});
