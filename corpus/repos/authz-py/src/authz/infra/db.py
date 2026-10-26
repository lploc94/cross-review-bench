"""Database engine, sessions and transactions."""

from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from urllib.parse import urlsplit, urlunsplit

from sqlalchemy import text
from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)

DRIVER = "postgresql+psycopg"


def to_driver_url(url: str) -> str:
    """The SQLAlchemy URL for psycopg 3 from a postgres:// or postgresql:// URL.

    This is the one place that knows the driver; both the async engine and Alembic use it.
    """
    parts = urlsplit(url)
    base = parts.scheme.split("+")[0]
    if base not in {"postgres", "postgresql"}:
        raise ValueError(f"not a PostgreSQL URL: scheme {parts.scheme!r}")
    return urlunsplit((DRIVER, parts.netloc, parts.path, parts.query, parts.fragment))


class Database:
    def __init__(self, url: str, *, pool_size: int = 10, echo: bool = False) -> None:
        self.engine: AsyncEngine = create_async_engine(
            to_driver_url(url),
            pool_size=pool_size,
            max_overflow=pool_size,
            pool_pre_ping=True,
            echo=echo,
        )
        self._sessions = async_sessionmaker(self.engine, expire_on_commit=False)

    @asynccontextmanager
    async def transaction(self) -> AsyncIterator[AsyncSession]:
        """A session inside one transaction: committed on success, rolled back on error."""
        async with self._sessions() as session, session.begin():
            yield session

    @asynccontextmanager
    async def read(self) -> AsyncIterator[AsyncSession]:
        """A session for reads. Closing it ends the transaction without expiring the objects
        it loaded, so callers can keep using them."""
        async with self._sessions() as session:
            yield session

    async def ping(self) -> None:
        async with self.engine.connect() as connection:
            await connection.execute(text("SELECT 1"))

    async def dispose(self) -> None:
        await self.engine.dispose()
