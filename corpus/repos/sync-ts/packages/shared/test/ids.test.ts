import { describe, expect, it } from "vitest";
import { ManualClock } from "../src/core/clock.js";
import { isValidNodeId } from "../src/core/hlc.js";
import { cryptoRandom, isDocId, isUuid, randomNodeId, randomUuid, seededRandom } from "../src/core/ids.js";
import { jsonEqual } from "../src/core/json.js";

describe("ids", () => {
  it("make valid lowercase v4 UUIDs", () => {
    for (let i = 0; i < 20; i++) expect(isUuid(randomUuid(cryptoRandom))).toBe(true);
  });

  it("are reproducible from a seed", () => {
    expect(randomUuid(seededRandom(7))).toBe(randomUuid(seededRandom(7)));
    expect(randomUuid(seededRandom(7))).not.toBe(randomUuid(seededRandom(8)));
  });

  it("make node ids the HLC accepts", () => {
    const node = randomNodeId(seededRandom(1));
    expect(node).toMatch(/^[0-9a-f]{16}$/);
    expect(isValidNodeId(node)).toBe(true);
  });

  it("check document ids", () => {
    expect(isDocId("note_2030-01")).toBe(true);
    expect(isDocId("")).toBe(false);
    expect(isDocId("a/b")).toBe(false);
    expect(isDocId("x".repeat(65))).toBe(false);
  });
});

describe("ManualClock", () => {
  it("moves only when told", () => {
    const clock = new ManualClock("2030-01-15T10:00:00.000Z");
    expect(clock.now()).toBe(Date.UTC(2030, 0, 15, 10));
    clock.advance(1500);
    expect(clock.now()).toBe(Date.UTC(2030, 0, 15, 10, 0, 1, 500));
    clock.set("2031-01-01T00:00:00.000Z");
    expect(clock.now()).toBe(Date.UTC(2031, 0, 1));
  });
});

describe("jsonEqual", () => {
  it("ignores key order but not array order", () => {
    expect(jsonEqual({ a: 1, b: [1, 2] }, { b: [1, 2], a: 1 })).toBe(true);
    expect(jsonEqual([1, 2], [2, 1])).toBe(false);
    expect(jsonEqual({ a: null }, {})).toBe(false);
    expect(jsonEqual(null, {})).toBe(false);
  });
});
