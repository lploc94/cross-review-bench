import { describe, expect, it } from "vitest";
import { FixedWindowRateLimiter } from "../../src/infra/rateLimiter.js";
import { ManualClock } from "../helpers/clock.js";
import { testRedis } from "../helpers/db.js";

describe("FixedWindowRateLimiter", () => {
  it("counts requests per subject within a one-minute window", async () => {
    const clock = new ManualClock("2030-01-15T10:00:20.000Z");
    const limiter = new FixedWindowRateLimiter({ redis: testRedis(), clock, limit: 2 });

    const first = await limiter.consume("key-a");
    expect(first).toMatchObject({ allowed: true, remaining: 1, retryAfterSeconds: 40 });
    expect(first.resetAt.toISOString()).toBe("2030-01-15T10:01:00.000Z");
    expect(await limiter.consume("key-a")).toMatchObject({ allowed: true, remaining: 0 });
    expect(await limiter.consume("key-a")).toMatchObject({ allowed: false, remaining: 0 });
    expect(await limiter.consume("key-b")).toMatchObject({ allowed: true, remaining: 1 });
  });

  it("starts a fresh count at the window boundary", async () => {
    const clock = new ManualClock("2030-01-15T10:00:59.999Z");
    const limiter = new FixedWindowRateLimiter({ redis: testRedis(), clock, limit: 1 });
    expect((await limiter.consume("key")).allowed).toBe(true);
    expect(await limiter.consume("key")).toMatchObject({ allowed: false, retryAfterSeconds: 1 });
    clock.advance(1);
    expect((await limiter.consume("key")).allowed).toBe(true);
  });

  it("lets its keys expire", async () => {
    const clock = new ManualClock("2030-01-15T10:00:00.000Z");
    const limiter = new FixedWindowRateLimiter({ redis: testRedis(), clock, limit: 5, keyPrefix: "rl" });
    await limiter.consume("key");
    const keys = await testRedis().keys("rl:key:*");
    expect(keys).toHaveLength(1);
    const ttl = await testRedis().pttl(keys[0] ?? "");
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(120_000);
  });
});
