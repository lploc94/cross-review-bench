"""Run locks: one PostgreSQL session-level advisory lock per source.

The lock lives on a connection of its own (in autocommit mode) for as long as the run, so it
holds across the run's transactions and is released by the server if the process dies.
"""

from __future__ import annotations

import zlib
from collections.abc import Iterator
from contextlib import contextmanager

from sqlalchemy import Connection, Engine, text

from etl.errors import RunLocked
from etl.logging import get_logger

# First key of the two-integer advisory lock form, so these locks never collide with locks
# other applications take on the same database with the one-bigint form or another namespace.
LOCK_NAMESPACE = 0x45_54_4C  # "ETL"

log = get_logger(__name__)


def lock_key(source: str) -> int:
    """A stable signed 32-bit key for a source name (the same in every process)."""
    value = zlib.crc32(source.encode("utf-8"))
    return value - 0x1_0000_0000 if value >= 0x8000_0000 else value


def try_lock(connection: Connection, source: str) -> bool:
    acquired = connection.execute(
        text("SELECT pg_try_advisory_lock(CAST(:ns AS integer), CAST(:key AS integer))"),
        {"ns": LOCK_NAMESPACE, "key": lock_key(source)},
    ).scalar_one()
    return bool(acquired)


def unlock(connection: Connection, source: str) -> bool:
    released = connection.execute(
        text("SELECT pg_advisory_unlock(CAST(:ns AS integer), CAST(:key AS integer))"),
        {"ns": LOCK_NAMESPACE, "key": lock_key(source)},
    ).scalar_one()
    return bool(released)


def is_locked(connection: Connection, source: str) -> bool:
    """Whether some session holds the run lock of `source` right now (a run is in progress).

    Reads pg_locks without taking the lock. A two-integer advisory lock shows its first key in
    `classid`, its second in `objid` (both as oid) and 2 in `objsubid`.
    """
    held = connection.execute(
        text(
            "SELECT EXISTS (SELECT 1 FROM pg_locks WHERE locktype = 'advisory'"
            " AND granted AND objsubid = 2"
            " AND classid = CAST(CAST(:ns AS integer) AS oid)"
            " AND objid = CAST(CAST(:key AS integer) AS oid)"
            " AND database = (SELECT oid FROM pg_database WHERE datname = current_database()))"
        ),
        {"ns": LOCK_NAMESPACE, "key": lock_key(source)},
    ).scalar_one()
    return bool(held)


@contextmanager
def source_lock(engine: Engine, source: str) -> Iterator[None]:
    """Hold the run lock of `source` for the duration of the block.

    Raises RunLocked at once, without waiting, when another session holds it.
    """
    connection = engine.connect()
    try:
        connection.execution_options(isolation_level="AUTOCOMMIT")
        if not try_lock(connection, source):
            raise RunLocked(source)
        try:
            yield
        finally:
            _release(connection, source)
    finally:
        connection.close()


def _release(connection: Connection, source: str) -> None:
    """Unlock, or discard the connection so that closing its session drops the lock.

    A pooled connection must never go back to the pool still holding the lock.
    """
    try:
        released = unlock(connection, source)
    except Exception:
        log.warning("lock.release_failed", source=source)
        connection.invalidate()
        return
    if not released:
        log.warning("lock.not_held", source=source)
        connection.invalidate()
