"""Redis connection."""

from __future__ import annotations

from redis.asyncio import Redis


def create_redis(url: str) -> Redis:
    return Redis.from_url(url, decode_responses=True, health_check_interval=30)


async def ping(redis: Redis) -> None:
    await redis.ping()
