"""Alembic environment: runs the migrations against DATABASE_URL with the psycopg driver."""

from __future__ import annotations

import os

from alembic import context
from sqlalchemy import Connection, create_engine, pool

from authz.infra.db import to_driver_url
from authz.models import Base

config = context.config
target_metadata = Base.metadata


def database_url() -> str:
    """The URL a caller passed in the Alembic config attributes, else DATABASE_URL."""
    url = config.attributes.get("database_url") or os.environ.get("DATABASE_URL")
    if not url:
        raise RuntimeError("DATABASE_URL is not set")
    return to_driver_url(str(url))


def run_offline() -> None:
    context.configure(
        url=database_url(),
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
    )
    with context.begin_transaction():
        context.run_migrations()


def run_with_connection(connection: Connection) -> None:
    context.configure(connection=connection, target_metadata=target_metadata)
    with context.begin_transaction():
        context.run_migrations()


def run_online() -> None:
    connection = config.attributes.get("connection")
    if isinstance(connection, Connection):
        run_with_connection(connection)
        return
    engine = create_engine(database_url(), poolclass=pool.NullPool)
    try:
        with engine.connect() as fresh:
            run_with_connection(fresh)
    finally:
        engine.dispose()


if context.is_offline_mode():
    run_offline()
else:
    run_online()
