from __future__ import annotations

from authz.infra.rate_limiter import FixedWindowRateLimiter, RateLimitRule
from tests.helpers.clock import FrozenClock

RULE = RateLimitRule(name="test", limit=3, window_seconds=60)


async def test_allows_up_to_the_limit_then_blocks(container, clock: FrozenClock):
    limiter = FixedWindowRateLimiter(container.redis, clock)

    results = [await limiter.hit(RULE, "subject") for _ in range(4)]

    assert [r.allowed for r in results] == [True, True, True, False]
    assert [r.remaining for r in results] == [2, 1, 0, 0]
    assert results[-1].retry_after > 0


async def test_retry_after_counts_down_to_the_window_end(container, clock: FrozenClock):
    limiter = FixedWindowRateLimiter(container.redis, clock)
    start = clock.now().timestamp()
    clock.advance(seconds=60 - (start % 60) - 15)
    for _ in range(3):
        await limiter.hit(RULE, "subject")

    blocked = await limiter.hit(RULE, "subject")

    assert blocked.retry_after == 15


async def test_each_window_starts_from_zero(container, clock: FrozenClock):
    limiter = FixedWindowRateLimiter(container.redis, clock)
    for _ in range(4):
        await limiter.hit(RULE, "subject")

    clock.advance(seconds=60)

    assert (await limiter.hit(RULE, "subject")).allowed


async def test_subjects_are_counted_separately(container, clock: FrozenClock):
    limiter = FixedWindowRateLimiter(container.redis, clock)
    for _ in range(4):
        await limiter.hit(RULE, "a")

    assert (await limiter.hit(RULE, "b")).allowed


async def test_keys_expire(container, clock: FrozenClock):
    limiter = FixedWindowRateLimiter(container.redis, clock)
    await limiter.hit(RULE, "ttl")
    start = int(clock.now().timestamp()) // 60 * 60

    ttl = await container.redis.ttl(FixedWindowRateLimiter.key(RULE, "ttl", start))

    assert 0 < ttl <= RULE.window_seconds + 5


async def test_reset_clears_the_current_window(container, clock: FrozenClock):
    limiter = FixedWindowRateLimiter(container.redis, clock)
    for _ in range(4):
        await limiter.hit(RULE, "subject")

    await limiter.reset(RULE, "subject")

    assert (await limiter.hit(RULE, "subject")).allowed
