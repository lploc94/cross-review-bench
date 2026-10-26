import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CURRENCY_CODES, exponentOf } from "../../src/domain/currency.js";
import { formatMinor, parseDecimal } from "../../src/domain/money.js";
import { buildTestApp, type TestApp } from "../helpers/app.js";
import { createTenant } from "../helpers/fixtures.js";

describe("formatMinor grouping", () => {
  it("puts a separator exactly every three whole digits", () => {
    const wholes = ["0", "1", "12", "123", "1234", "12345", "123456", "1234567", "1000000000000"];
    for (const code of CURRENCY_CODES) {
      const exponent = exponentOf(code);
      for (const whole of wholes) {
        const minor = BigInt(whole) * 10n ** BigInt(exponent) + (exponent > 0 ? 7n : 0n);
        const plain = formatMinor(minor, code);
        const grouped = formatMinor(minor, code, { grouping: true });
        expect(grouped.replaceAll(",", ""), `${code} ${whole}`).toBe(plain);
        const [groupedWhole] = grouped.split(".");
        expect(groupedWhole, `${code} ${whole}`).toMatch(/^\d{1,3}(?:,\d{3})*$/);
        expect(parseDecimal(plain, code)).toBe(minor);
        expect(formatMinor(-minor, code, { grouping: true })).toBe(minor === 0n ? grouped : `-${grouped}`);
      }
    }
  });

  it("does not depend on the process locale", () => {
    expect(formatMinor(123456789012n, "EUR", { grouping: true })).toBe("1,234,567,890.12");
    expect(formatMinor(1234567890n, "BHD", { grouping: true })).toBe("1,234,567.890");
  });
});

describe("currency catalogue", () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await buildTestApp();
  });

  afterAll(async () => {
    await t.close();
  });

  it("serves every currency the code knows, matching the reference table", async () => {
    const tenant = await createTenant(t.pool, t.clock, { scopes: ["accounts:read"] });
    const list = await t.app.inject({ method: "GET", url: "/currencies", headers: tenant.headers });
    expect(list.statusCode).toBe(200);
    const data = list.json<{ data: { code: string; exponent: number; minor_unit: string }[] }>().data;
    expect(data).toHaveLength(CURRENCY_CODES.length);
    for (const currency of data) {
      expect(CURRENCY_CODES).toContain(currency.code);
      const code = currency.code as (typeof CURRENCY_CODES)[number];
      expect(currency.exponent).toBe(exponentOf(code));
      expect(parseDecimal(currency.minor_unit, code)).toBe(1n);
      const one = await t.app.inject({ method: "GET", url: `/currencies/${code}`, headers: tenant.headers });
      expect(one.json()).toEqual(currency);
    }
  });
});
