"""Request counters in Redis."""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Protocol

from redis.asyncio import Redis

from authz.infra.clock import Clock

KEY_PREFIX = "authz:rl"

# INCR and EXPIRE run atomically: a key never outlives its window, even if the caller dies
# between the two commands.
_FIXED_WINDOW_SCRIPT = """
local count = redis.call('INCR', KEYS[1])
if count == 1 then
  redis.call('EXPIRE', KEYS[1], ARGV[1])
end
return count
"""


@dataclass(frozen=True, slots=True)
class RateLimitResult:
    allowed: bool
    limit: int
    remaining: int
    retry_after: int


@dataclass(frozen=True, slots=True)
class RateLimitRule:
    """At most `limit` hits per `window_seconds` for one subject of the named bucket."""

    name: str
    limit: int
    window_seconds: int


class RateLimiter(Protocol):
    async def hit(self, rule: RateLimitRule, subject: str) -> RateLimitResult: ...

    async def reset(self, rule: RateLimitRule, subject: str) -> None: ...


class FixedWindowRateLimiter:
    """Counts hits per window aligned to the epoch: [k * window, (k + 1) * window)."""

    def __init__(self, redis: Redis, clock: Clock) -> None:
        self._redis = redis
        self._clock = clock
        self._script = redis.register_script(_FIXED_WINDOW_SCRIPT)

    def _window(self, rule: RateLimitRule) -> tuple[int, int]:
        now = self._clock.now().timestamp()
        start = math.floor(now / rule.window_seconds) * rule.window_seconds
        retry_after = max(1, math.ceil(start + rule.window_seconds - now))
        return start, retry_after

    @staticmethod
    def key(rule: RateLimitRule, subject: str, window_start: int) -> str:
        return f"{KEY_PREFIX}:{rule.name}:{window_start}:{subject}"

    async def hit(self, rule: RateLimitRule, subject: str) -> RateLimitResult:
        start, retry_after = self._window(rule)
        key = self.key(rule, subject, start)
        # A little longer than the window, so a slow clock never sees the key vanish early.
        ttl = rule.window_seconds + 5
        count = int(await self._script(keys=[key], args=[ttl]))
        allowed = count <= rule.limit
        return RateLimitResult(
            allowed=allowed,
            limit=rule.limit,
            remaining=max(0, rule.limit - count),
            retry_after=0 if allowed else retry_after,
        )

    async def reset(self, rule: RateLimitRule, subject: str) -> None:
        start, _ = self._window(rule)
        await self._redis.delete(self.key(rule, subject, start))
