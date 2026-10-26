/**
 * The physical time source behind every hybrid logical clock and every timestamp the server
 * writes: milliseconds since the Unix epoch. Tests and simulations inject a ManualClock.
 */
export interface PhysicalClock {
  now(): number;
}

export const systemClock: PhysicalClock = {
  now: () => Date.now(),
};

/** A clock that only moves when its owner moves it (tests, simulations, replays). */
export class ManualClock implements PhysicalClock {
  private current: number;

  constructor(start: number | string | Date = "2030-01-15T10:00:00.000Z") {
    this.current = toEpochMs(start);
  }

  now(): number {
    return this.current;
  }

  set(time: number | string | Date): void {
    this.current = toEpochMs(time);
  }

  /** Move by `ms`; a negative value moves the clock back, as a corrected system clock can. */
  advance(ms: number): void {
    this.current += ms;
  }
}

function toEpochMs(time: number | string | Date): number {
  const ms = typeof time === "number" ? time : new Date(time).getTime();
  if (!Number.isSafeInteger(ms)) {
    throw new RangeError(`invalid time: ${String(time)}`);
  }
  return ms;
}
