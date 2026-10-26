"""The Alembic migrations seen from the running service: which revision the database is at,
which one the code needs, and upgrading to it.

Alembic's configuration (`alembic.ini`) is found by path; it names the migrations directory.
The database URL comes from the settings, never from the file.
"""

from __future__ import annotations

from pathlib import Path

from alembic import command
from alembic.config import Config
from alembic.runtime.migration import MigrationContext
from alembic.script import ScriptDirectory
from sqlalchemy import Engine

from etl.errors import InvalidRequest

DEFAULT_CONFIG = Path("alembic.ini")


def load_config(path: Path, database_url: str) -> Config:
    if not path.is_file():
        raise InvalidRequest(f"no Alembic configuration at {path}")
    config = Config(str(path))
    config.attributes["database_url"] = database_url
    return config


def head_revision(config: Config) -> str | None:
    """The newest revision of the migration scripts (None when there are none)."""
    heads = ScriptDirectory.from_config(config).get_heads()
    if len(heads) > 1:
        raise InvalidRequest(f"the migrations have several heads: {', '.join(sorted(heads))}")
    return heads[0] if heads else None


def current_revision(engine: Engine) -> str | None:
    """The revision the database is at (None before the first migration)."""
    with engine.connect() as connection:
        return MigrationContext.configure(connection).get_current_revision()


def upgrade(config: Config) -> None:
    command.upgrade(config, "head")
