import type { Redis } from "ioredis";
import type { Clock } from "./clock.js";

export interface RateLimitDecision {
  readonly allowed: boolean;
  readonly limit: number;
  readonly remaining: number;
  /** Start of the next window. */
  readonly resetAt: Date;
  /** Whole seconds until the next window opens (at least 1). */
  readonly retryAfterSeconds: number;
}

export interface RateLimiter {
  consume(subject: string): Promise<RateLimitDecision>;
}

export interface FixedWindowOptions {
  readonly redis: Redis;
  readonly clock: Clock;
  readonly limit: number;
  readonly windowMs?: number;
  readonly keyPrefix?: string;
}

/**
 * Fixed-window counter in Redis: one key per subject and window, incremented on every request
 * and left to expire after the window. The window boundaries come from the injected clock, so
 * every instance of the service counts into the same key for the same minute.
 */
export class FixedWindowRateLimiter implements RateLimiter {
  private readonly redis: Redis;
  private readonly clock: Clock;
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly keyPrefix: string;

  constructor(options: FixedWindowOptions) {
    this.redis = options.redis;
    this.clock = options.clock;
    this.limit = options.limit;
    this.windowMs = options.windowMs ?? 60_000;
    this.keyPrefix = options.keyPrefix ?? "ratelimit";
  }

  async consume(subject: string): Promise<RateLimitDecision> {
    const nowMs = this.clock.now().getTime();
    const windowStart = Math.floor(nowMs / this.windowMs) * this.windowMs;
    const windowEnd = windowStart + this.windowMs;
    const key = `${this.keyPrefix}:${subject}:${windowStart}`;

    const results = await this.redis
      .multi()
      .incr(key)
      .pexpire(key, this.windowMs * 2)
      .exec();
    const count = readCount(results);

    return {
      allowed: count <= this.limit,
      limit: this.limit,
      remaining: Math.max(0, this.limit - count),
      resetAt: new Date(windowEnd),
      retryAfterSeconds: Math.max(1, Math.ceil((windowEnd - nowMs) / 1000)),
    };
  }
}

type ExecResult = [error: Error | null, result: unknown][] | null;

function readCount(results: ExecResult): number {
  const first = results?.[0];
  if (!first) {
    throw new Error("rate limit transaction was aborted");
  }
  const [error, value] = first;
  if (error) throw error;
  if (typeof value !== "number") {
    throw new Error(`unexpected INCR reply ${String(value)}`);
  }
  return value;
}
