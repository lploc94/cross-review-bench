"""Database helpers: Alembic configuration, truncation and small queries for assertions."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from alembic.config import Config
from sqlalchemy import Engine, Table, func, select, text

from etl.infra.locks import LOCK_NAMESPACE, lock_key
from etl.infra.tables import ETL_SCHEMA, WAREHOUSE_SCHEMA

ROOT = Path(__file__).resolve().parents[2]


def alembic_config(database_url: str) -> Config:
    config = Config(str(ROOT / "alembic.ini"))
    config.attributes["database_url"] = database_url
    return config


def truncate_all(engine: Engine) -> None:
    """Empty every table of the service's schemas and restart their identities."""
    with engine.begin() as connection:
        names = (
            connection.execute(
                text(
                    "SELECT quote_ident(schemaname) || '.' || quote_ident(tablename) "
                    "FROM pg_tables WHERE schemaname IN (:etl, :warehouse)"
                ),
                {"etl": ETL_SCHEMA, "warehouse": WAREHOUSE_SCHEMA},
            )
            .scalars()
            .all()
        )
        if names:
            connection.execute(text(f"TRUNCATE {', '.join(names)} RESTART IDENTITY CASCADE"))


def rows(
    engine: Engine, table: Table, *, order_by: str | None = None, **where: Any
) -> list[dict[str, Any]]:
    statement = select(table)
    for column, value in where.items():
        statement = statement.where(table.c[column] == value)
    if order_by is not None:
        statement = statement.order_by(*(table.c[name] for name in order_by.split(",")))
    with engine.connect() as connection:
        return [dict(row) for row in connection.execute(statement).mappings()]


def count(engine: Engine, table: Table, **where: Any) -> int:
    statement = select(func.count()).select_from(table)
    for column, value in where.items():
        statement = statement.where(table.c[column] == value)
    with engine.connect() as connection:
        return int(connection.execute(statement).scalar_one())


class HeldLock:
    """Holds a source's run lock from another session, like a concurrent run would."""

    def __init__(self, engine: Engine, source: str) -> None:
        self._connection = engine.connect().execution_options(isolation_level="AUTOCOMMIT")
        self._source = source

    def __enter__(self) -> HeldLock:
        acquired = self._connection.execute(
            text("SELECT pg_try_advisory_lock(CAST(:ns AS integer), CAST(:key AS integer))"),
            {"ns": LOCK_NAMESPACE, "key": lock_key(self._source)},
        ).scalar_one()
        assert acquired, f"the {self._source} lock was already held"
        return self

    def __exit__(self, *exc: object) -> None:
        try:
            self._connection.execute(
                text("SELECT pg_advisory_unlock(CAST(:ns AS integer), CAST(:key AS integer))"),
                {"ns": LOCK_NAMESPACE, "key": lock_key(self._source)},
            )
        finally:
            self._connection.close()


def lock_is_free(engine: Engine, source: str) -> bool:
    """Whether another session can take the source's run lock right now."""
    with engine.connect().execution_options(isolation_level="AUTOCOMMIT") as connection:
        params = {"ns": LOCK_NAMESPACE, "key": lock_key(source)}
        acquired = connection.execute(
            text("SELECT pg_try_advisory_lock(CAST(:ns AS integer), CAST(:key AS integer))"),
            params,
        ).scalar_one()
        if acquired:
            connection.execute(
                text("SELECT pg_advisory_unlock(CAST(:ns AS integer), CAST(:key AS integer))"),
                params,
            )
        return bool(acquired)
