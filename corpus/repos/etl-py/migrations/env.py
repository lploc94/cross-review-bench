"""Alembic environment: runs the migrations against DATABASE_URL with the psycopg driver."""

from __future__ import annotations

import os

from alembic import context
from sqlalchemy import Connection, create_engine, pool

from etl.infra.db import to_driver_url
from etl.infra.tables import ETL_SCHEMA, WAREHOUSE_SCHEMA, metadata

config = context.config
target_metadata = metadata
SCHEMAS = {ETL_SCHEMA, WAREHOUSE_SCHEMA}


def database_url() -> str:
    """The URL a caller passed in the Alembic config attributes, else DATABASE_URL."""
    url = config.attributes.get("database_url") or os.environ.get("DATABASE_URL")
    if not url:
        raise RuntimeError("DATABASE_URL is not set")
    return to_driver_url(str(url))


def include_name(name: str | None, type_: str, parent_names: object) -> bool:
    """Autogenerate looks at the service's schemas only."""
    if type_ == "schema":
        return name in SCHEMAS
    return True


def configure(**options: object) -> None:
    context.configure(
        target_metadata=target_metadata,
        include_schemas=True,
        include_name=include_name,
        **options,  # type: ignore[arg-type]
    )


def run_offline() -> None:
    configure(url=database_url(), literal_binds=True, dialect_opts={"paramstyle": "named"})
    with context.begin_transaction():
        context.run_migrations()


def run_with_connection(connection: Connection) -> None:
    configure(connection=connection)
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
