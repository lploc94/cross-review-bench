/**
 * The source of "now" for every time-dependent decision (session expiry, signed-URL expiry, scan
 * backoff, cleanup grace periods, timestamps written by the services). Tests inject a clock they move.
 */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = {
  now: () => new Date(),
};

/** `date` moved by `seconds` (negative to go back). */
export function addSeconds(date: Date, seconds: number): Date {
  return new Date(date.getTime() + seconds * 1000);
}
