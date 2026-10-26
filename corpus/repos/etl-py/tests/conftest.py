"""Fixtures shared by every test directory (tests/<area>/ and any directory added later).

DATABASE_URL must name an empty PostgreSQL database used by the tests alone: the schema is
migrated once per session and every table of the `etl` and `warehouse` schemas is truncated
before each test that uses the database.
"""

from __future__ import annotations

import os
from collections.abc import Iterator
from pathlib import Path

import pytest
from alembic import command
from pydantic import SecretStr
from sqlalchemy import Engine
from typer.testing import CliRunner, Result

from etl.api.context import AppContext
from etl.cli.app import build_app
from etl.config import Settings
from etl.infra.db import create_db_engine
from etl.logging import configure_logging
from etl.pipeline.runner import Pipeline
from tests.helpers.clock import FrozenClock
from tests.helpers.db import alembic_config, truncate_all


@pytest.fixture(scope="session", autouse=True)
def _json_logging() -> None:
    """Every test runs with the production log pipeline (redaction included)."""
    configure_logging("debug")


@pytest.fixture(scope="session")
def database_url() -> str:
    value = os.environ.get("DATABASE_URL")
    if not value:
        pytest.fail("DATABASE_URL must be set for the database tests (see README.md, Testing)")
    return value


@pytest.fixture(scope="session")
def migrated_database(database_url: str) -> str:
    """Run the Alembic migrations once for the whole session."""
    command.upgrade(alembic_config(database_url), "head")
    return database_url


@pytest.fixture(scope="session")
def engine(migrated_database: str) -> Iterator[Engine]:
    built = create_db_engine(migrated_database, pool_size=5)
    try:
        yield built
    finally:
        built.dispose()


@pytest.fixture
def db(engine: Engine) -> Engine:
    """The engine, on empty tables."""
    truncate_all(engine)
    return engine


@pytest.fixture
def clock() -> FrozenClock:
    return FrozenClock()


def make_settings(database_url: str, report_dir: Path, **overrides: object) -> Settings:
    values: dict[str, object] = {
        "database_url": SecretStr(database_url),
        "report_dir": report_dir,
        "reporting_zone": "Europe/Berlin",
        "max_reject_ratio": 0.25,
        # Small batches, so that every test file crosses batch boundaries.
        "batch_size": 2,
        "log_level": "debug",
    }
    values.update(overrides)
    return Settings.model_validate(values)


@pytest.fixture
def settings(migrated_database: str, tmp_path: Path) -> Settings:
    return make_settings(migrated_database, tmp_path / "reports")


@pytest.fixture
def pipeline(db: Engine, settings: Settings, clock: FrozenClock) -> Pipeline:
    return Pipeline(db, settings, clock)


@pytest.fixture
def context(db: Engine, settings: Settings, clock: FrozenClock) -> AppContext:
    return AppContext(settings=settings, engine=db, clock=clock, owns_engine=False)


class Cli:
    """The real `etl` command tree, run in-process against the test context."""

    def __init__(self, context: AppContext) -> None:
        self.context = context
        self.app = build_app(lambda: context)
        self.runner = CliRunner()

    def __call__(self, *args: str, input: str | None = None) -> Result:
        return self.runner.invoke(self.app, [str(arg) for arg in args], input=input)


@pytest.fixture
def cli(context: AppContext) -> Cli:
    return Cli(context)
