import { describe, expect, it } from "vitest";
import { ValidationError } from "../../src/domain/errors.js";
import { RATE_SCALE, convert, formatRate, parseRate } from "../../src/domain/fx.js";

describe("convert", () => {
  it("converts between currencies with the same exponent", () => {
    // 10.00 EUR at 1.085 USD/EUR = 10.85 USD
    expect(convert(1000n, "EUR", "USD", parseRate("1.085"))).toBe(1085n);
  });

  it("accounts for the exponent difference between currencies", () => {
    // 10.00 USD at 150.25 JPY/USD = 1502.5 JPY, a tie rounded to even: 1502 JPY
    expect(convert(1000n, "USD", "JPY", parseRate("150.25"))).toBe(1502n);
    // 1000 JPY at 0.0066 USD/JPY = 6.60 USD
    expect(convert(1000n, "JPY", "USD", parseRate("0.0066"))).toBe(660n);
    // 1.000 KWD at 3.25 USD/KWD = 3.25 USD
    expect(convert(1000n, "KWD", "USD", parseRate("3.25"))).toBe(325n);
    // 1.00 USD at 0.3075 KWD/USD = 0.3075 KWD → 0.308 (half to even)
    expect(convert(100n, "USD", "KWD", parseRate("0.3075"))).toBe(308n);
  });

  it("rounds half to even, not half up", () => {
    // 0.25 EUR at 0.5 = 0.125 GBP → 0.12
    expect(convert(25n, "EUR", "GBP", parseRate("0.5"))).toBe(12n);
    // 0.35 EUR at 0.5 = 0.175 GBP → 0.18
    expect(convert(35n, "EUR", "GBP", parseRate("0.5"))).toBe(18n);
  });

  it("converts large amounts without losing precision", () => {
    const amount = 123_456_789_012_345n;
    expect(convert(amount, "VND", "JPY", RATE_SCALE)).toBe(amount);
    expect(convert(amount, "USD", "EUR", parseRate("0.00000001"))).toBe(1_234_568n);
  });

  it("rejects non-positive rates", () => {
    expect(() => convert(100n, "USD", "EUR", 0n)).toThrow(RangeError);
  });
});

describe("parseRate and formatRate", () => {
  it("scale rates to eight decimal places", () => {
    expect(parseRate("1.085")).toBe(108_500_000n);
    expect(parseRate("0.00000001")).toBe(1n);
    expect(parseRate("150")).toBe(15_000_000_000n);
    expect(formatRate(108_500_000n)).toBe("1.08500000");
    expect(formatRate(1n)).toBe("0.00000001");
  });

  it("reject zero, negative and over-precise rates", () => {
    expect(() => parseRate("0")).toThrow(ValidationError);
    expect(() => parseRate("-1.2")).toThrow(ValidationError);
    expect(() => parseRate("1.000000001")).toThrow(ValidationError);
  });
});
