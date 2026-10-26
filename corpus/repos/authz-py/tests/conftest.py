"""Fixtures shared by every test directory.

DATABASE_URL must name an empty PostgreSQL database and REDIS_URL a Redis logical database, both
used by the tests alone: the schema is migrated once per run, every table is truncated before
each test that uses the database, and the Redis database is flushed (FLUSHDB, never FLUSHALL).
"""

from __future__ import annotations

import os
from collections.abc import AsyncIterator
from pathlib import Path

import httpx
import pytest
from alembic import command
from alembic.config import Config
from fastapi import FastAPI
from pydantic import SecretStr
from sqlalchemy import text

from authz.app import create_app
from authz.config import Settings
from authz.container import Container, build_container
from tests.helpers.clock import FrozenClock
from tests.helpers.doubles import RecordingMailer, SeededRandom

ROOT = Path(__file__).resolve().parent.parent
TEST_SECRET = "test-signing-secret-0123456789abcdef"


def _required_env(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        pytest.fail(f"{name} must be set for the test suite (see README.md, Testing)")
    return value


def alembic_config(database_url: str) -> Config:
    config = Config(str(ROOT / "alembic.ini"))
    config.attributes["database_url"] = database_url
    return config


@pytest.fixture(scope="session")
def database_url() -> str:
    return _required_env("DATABASE_URL")


@pytest.fixture(scope="session")
def redis_url() -> str:
    return _required_env("REDIS_URL")


@pytest.fixture(scope="session")
def migrated_database(database_url: str) -> str:
    """Run the Alembic migrations once for the whole session."""
    command.upgrade(alembic_config(database_url), "head")
    return database_url


def make_settings(database_url: str, redis_url: str, **overrides: object) -> Settings:
    values: dict[str, object] = {
        "environment": "test",
        "database_url": SecretStr(database_url),
        "redis_url": SecretStr(redis_url),
        "database_pool_size": 5,
        "jwt_secrets": [SecretStr(TEST_SECRET)],
        "argon2_time_cost": 1,
        "argon2_memory_cost_kib": 8,
        "argon2_parallelism": 1,
        "trust_proxy_headers": True,
        "public_base_url": "https://authz.example.com",
    }
    values.update(overrides)
    return Settings.model_validate(values)


@pytest.fixture
def settings(migrated_database: str, redis_url: str) -> Settings:
    return make_settings(migrated_database, redis_url)


@pytest.fixture
def clock() -> FrozenClock:
    return FrozenClock()


@pytest.fixture
def random_source() -> SeededRandom:
    return SeededRandom()


@pytest.fixture
def mailer() -> RecordingMailer:
    return RecordingMailer()


async def reset_state(container: Container) -> None:
    async with container.db.transaction() as session:
        tables = (
            await session.execute(
                text(
                    "SELECT tablename FROM pg_tables "
                    "WHERE schemaname = 'public' AND tablename <> 'alembic_version'"
                )
            )
        ).scalars()
        names = ", ".join(f'"{name}"' for name in tables)
        if names:
            await session.execute(text(f"TRUNCATE {names} RESTART IDENTITY CASCADE"))
    await container.redis.flushdb()


@pytest.fixture
async def container(
    settings: Settings,
    clock: FrozenClock,
    random_source: SeededRandom,
    mailer: RecordingMailer,
) -> AsyncIterator[Container]:
    built = build_container(settings, clock=clock, random=random_source, mailer=mailer)
    await reset_state(built)
    try:
        yield built
    finally:
        await built.aclose()


@pytest.fixture
def app(container: Container) -> FastAPI:
    return create_app(container)


@pytest.fixture
async def client(app: FastAPI) -> AsyncIterator[httpx.AsyncClient]:
    transport = httpx.ASGITransport(app=app, raise_app_exceptions=False)
    async with httpx.AsyncClient(transport=transport, base_url="http://authz.test") as http:
        yield http
