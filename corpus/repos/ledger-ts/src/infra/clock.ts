/**
 * The source of "now" for every time-dependent decision (hold expiry, rate-limit windows,
 * outbox retry schedules, timestamps written by the services). Tests inject a clock they move.
 */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = {
  now: () => new Date(),
};
