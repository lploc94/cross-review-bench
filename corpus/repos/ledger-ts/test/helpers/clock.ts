import type { Clock } from "../../src/infra/clock.js";

export const DEFAULT_TEST_TIME = "2030-01-15T10:00:00.000Z";

/** A clock that only moves when the test moves it. */
export class ManualClock implements Clock {
  private current: number;

  constructor(start: Date | string = DEFAULT_TEST_TIME) {
    this.current = new Date(start).getTime();
  }

  now(): Date {
    return new Date(this.current);
  }

  set(time: Date | string): void {
    this.current = new Date(time).getTime();
  }

  advance(ms: number): void {
    this.current += ms;
  }

  advanceSeconds(seconds: number): void {
    this.advance(seconds * 1000);
  }
}
