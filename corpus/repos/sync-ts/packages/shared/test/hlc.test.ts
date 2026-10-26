import { describe, expect, it } from "vitest";
import { ManualClock } from "../src/core/clock.js";
import { ClockDriftError, HlcCounterOverflowError, InvalidHlcError } from "../src/core/errors.js";
import {
  Hlc,
  MAX_COUNTER,
  compareHlc,
  compareHlcStrings,
  formatHlc,
  isHlcString,
  parseHlc,
  type HlcTimestamp,
} from "../src/core/hlc.js";

const T0 = 1_894_701_600_000;

function clockAt(ms = T0): ManualClock {
  return new ManualClock(ms);
}

describe("HLC string form", () => {
  it("round-trips", () => {
    const ts = { wallMs: T0, counter: 42, node: "a1b2-c3" };
    expect(formatHlc(ts)).toBe(`00${T0}:00042:a1b2-c3`);
    expect(parseHlc(formatHlc(ts))).toEqual(ts);
  });

  it("sorts as strings in the same order as compareHlc", () => {
    const stamps: HlcTimestamp[] = [
      { wallMs: 9, counter: 0, node: "b" },
      { wallMs: 10, counter: 0, node: "a" },
      { wallMs: 10, counter: 2, node: "a" },
      { wallMs: 10, counter: 10, node: "a" },
      { wallMs: 10, counter: 10, node: "a-b" },
      { wallMs: 10, counter: 10, node: "ab" },
      { wallMs: 100, counter: 0, node: "a" },
    ];
    const byString = [...stamps].map(formatHlc).sort();
    const byOrder = [...stamps].sort(compareHlc).map(formatHlc);
    expect(byString).toEqual(byOrder);
  });

  it("rejects malformed strings and out-of-range parts", () => {
    for (const text of [
      "",
      "123:00000:node",
      `00${T0}:0000:node`,
      `00${T0}:00000:`,
      `00${T0}:00000:Node`,
      `00${T0}:00000:-node`,
      `00${T0}:99999:node`,
      ` 00${T0}:00000:node`,
    ]) {
      expect(() => parseHlc(text), text).toThrow(InvalidHlcError);
      expect(isHlcString(text)).toBe(false);
    }
  });

  it("refuses to format invalid timestamps", () => {
    expect(() => formatHlc({ wallMs: -1, counter: 0, node: "a" })).toThrow(InvalidHlcError);
    expect(() => formatHlc({ wallMs: 1.5, counter: 0, node: "a" })).toThrow(InvalidHlcError);
    expect(() => formatHlc({ wallMs: 1, counter: MAX_COUNTER + 1, node: "a" })).toThrow(InvalidHlcError);
    expect(() => formatHlc({ wallMs: 1, counter: 0, node: "x".repeat(65) })).toThrow(InvalidHlcError);
  });

  it("compares strings by their timestamps", () => {
    const a = formatHlc({ wallMs: T0, counter: 1, node: "a" });
    const b = formatHlc({ wallMs: T0, counter: 1, node: "b" });
    expect(compareHlcStrings(a, b)).toBe(-1);
    expect(compareHlcStrings(b, a)).toBe(1);
    expect(compareHlcStrings(a, a)).toBe(0);
  });
});

describe("Hlc.now", () => {
  it("follows the physical clock when it moves", () => {
    const clock = clockAt();
    const hlc = new Hlc({ node: "n1", clock });
    expect(hlc.now()).toEqual({ wallMs: T0, counter: 0, node: "n1" });
    clock.advance(5);
    expect(hlc.now()).toEqual({ wallMs: T0 + 5, counter: 0, node: "n1" });
  });

  it("counts events within one millisecond", () => {
    const hlc = new Hlc({ node: "n1", clock: clockAt() });
    hlc.now();
    expect(hlc.now().counter).toBe(1);
    expect(hlc.now().counter).toBe(2);
  });

  it("never goes back when the physical clock does", () => {
    const clock = clockAt();
    const hlc = new Hlc({ node: "n1", clock });
    const first = hlc.now();
    clock.advance(-10_000);
    const second = hlc.now();
    expect(compareHlc(second, first)).toBe(1);
    expect(second).toEqual({ wallMs: T0, counter: 1, node: "n1" });
  });

  it("refuses to overflow the counter, and recovers once time moves", () => {
    const clock = clockAt();
    const hlc = new Hlc({ node: "n1", clock });
    hlc.restore({ wallMs: T0, counter: MAX_COUNTER, node: "n1" });
    expect(() => hlc.now()).toThrow(HlcCounterOverflowError);
    expect(hlc.last.counter).toBe(MAX_COUNTER);
    clock.advance(1);
    expect(hlc.now()).toEqual({ wallMs: T0 + 1, counter: 0, node: "n1" });
  });

  it("rejects a physical clock that returns nonsense", () => {
    const hlc = new Hlc({ node: "n1", clock: { now: () => Number.NaN } });
    expect(() => hlc.now()).toThrow(RangeError);
  });
});

describe("Hlc.receive", () => {
  it("jumps ahead of a remote timestamp from the future", () => {
    const hlc = new Hlc({ node: "local", clock: clockAt() });
    const received = hlc.receive({ wallMs: T0 + 500, counter: 3, node: "remote" });
    expect(received).toEqual({ wallMs: T0 + 500, counter: 4, node: "local" });
    expect(compareHlc(hlc.now(), { wallMs: T0 + 500, counter: 3, node: "remote" })).toBe(1);
  });

  it("takes the larger counter when local and remote walls tie", () => {
    const clock = clockAt(T0 - 100);
    const hlc = new Hlc({ node: "local", clock });
    hlc.restore({ wallMs: T0, counter: 5, node: "local" });
    expect(hlc.receive({ wallMs: T0, counter: 9, node: "remote" })).toMatchObject({ wallMs: T0, counter: 10 });
    expect(hlc.receive({ wallMs: T0, counter: 2, node: "remote" })).toMatchObject({ wallMs: T0, counter: 11 });
  });

  it("keeps its own wall when the remote one is older", () => {
    const clock = clockAt(T0 - 100);
    const hlc = new Hlc({ node: "local", clock });
    hlc.restore({ wallMs: T0, counter: 5, node: "local" });
    expect(hlc.receive({ wallMs: T0 - 50, counter: 99, node: "remote" })).toMatchObject({ wallMs: T0, counter: 6 });
  });

  it("restarts the counter when the physical clock is ahead of both", () => {
    const hlc = new Hlc({ node: "local", clock: clockAt() });
    hlc.restore({ wallMs: T0 - 10, counter: 5, node: "local" });
    expect(hlc.receive({ wallMs: T0 - 5, counter: 7, node: "remote" })).toMatchObject({ wallMs: T0, counter: 0 });
  });

  it("refuses a timestamp further ahead than the allowed drift, without moving", () => {
    const hlc = new Hlc({ node: "local", clock: clockAt(), maxDriftMs: 1_000 });
    hlc.now();
    const before = hlc.last;
    expect(() => hlc.receive({ wallMs: T0 + 1_001, counter: 0, node: "remote" })).toThrow(ClockDriftError);
    expect(hlc.last).toEqual(before);
    expect(hlc.receive({ wallMs: T0 + 1_000, counter: 0, node: "remote" }).wallMs).toBe(T0 + 1_000);
  });

  it("reports the drift it refused", () => {
    const hlc = new Hlc({ node: "local", clock: clockAt(), maxDriftMs: 10 });
    try {
      hlc.receive({ wallMs: T0 + 25, counter: 0, node: "remote" });
      expect.unreachable();
    } catch (err) {
      expect(err).toMatchObject({ code: "clock_drift", retryable: false, remoteWallMs: T0 + 25, physicalMs: T0 });
    }
  });

  it("refuses to overflow the counter on receive", () => {
    const hlc = new Hlc({ node: "local", clock: clockAt() });
    expect(() => hlc.receive({ wallMs: T0, counter: MAX_COUNTER, node: "remote" })).toThrow(HlcCounterOverflowError);
  });
});

describe("Hlc.restore", () => {
  it("continues after a stored timestamp ahead of the physical clock", () => {
    const hlc = new Hlc({ node: "n1", clock: clockAt(T0) });
    hlc.restore({ wallMs: T0 + 2_000, counter: 4, node: "n1" });
    expect(hlc.now()).toEqual({ wallMs: T0 + 2_000, counter: 5, node: "n1" });
  });

  it("uses the physical clock when the stored timestamp is older", () => {
    const hlc = new Hlc({ node: "n1", clock: clockAt(T0) });
    hlc.restore({ wallMs: T0 - 2_000, counter: 4, node: "n1" });
    expect(hlc.now()).toEqual({ wallMs: T0, counter: 0, node: "n1" });
  });

  it("never moves the clock back", () => {
    const hlc = new Hlc({ node: "n1", clock: clockAt(T0) });
    hlc.now();
    hlc.now();
    hlc.restore({ wallMs: T0, counter: 0, node: "n1" });
    expect(hlc.last.counter).toBe(1);
  });
});

describe("Hlc options", () => {
  it("validate the node id and the drift", () => {
    expect(() => new Hlc({ node: "Upper", clock: clockAt() })).toThrow(InvalidHlcError);
    expect(() => new Hlc({ node: "n1", clock: clockAt(), maxDriftMs: -1 })).toThrow(RangeError);
  });
});
