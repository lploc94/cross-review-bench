"""Per-source watermarks in `etl.watermarks`: the newest source `updated_at` loaded so far.

The watermark only moves forward, and only in the transaction that loads the rows behind it.
Writes compare and set: a run states the value it started from, and the write fails with
WatermarkConflict when someone changed the row in the meantime.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Any

from sqlalchemy import Connection, delete, select, update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.sql.dml import ReturningInsert, ReturningUpdate

from etl.errors import WatermarkConflict
from etl.infra.tables import watermarks


@dataclass(frozen=True, slots=True)
class Watermark:
    source: str
    high_water: datetime
    updated_at: datetime


def read(connection: Connection, source: str) -> Watermark | None:
    row = (
        connection.execute(select(watermarks).where(watermarks.c.source == source))
        .mappings()
        .first()
    )
    if row is None:
        return None
    return Watermark(row["source"], row["high_water"], row["updated_at"])


def read_all(connection: Connection) -> list[Watermark]:
    rows = connection.execute(select(watermarks).order_by(watermarks.c.source)).mappings()
    return [Watermark(row["source"], row["high_water"], row["updated_at"]) for row in rows]


def advance(
    connection: Connection,
    source: str,
    *,
    expected: datetime | None,
    new: datetime,
    now: datetime,
) -> None:
    """Move the watermark from `expected` (None: no watermark yet) to `new`.

    Raises WatermarkConflict when the stored value is no longer `expected`, and ValueError
    when `new` would move it backwards.
    """
    if expected is not None and new < expected:
        raise ValueError("a watermark never moves backwards")
    statement: ReturningInsert[Any] | ReturningUpdate[Any]
    if expected is None:
        statement = (
            pg_insert(watermarks)
            .values(source=source, high_water=new, updated_at=now)
            .on_conflict_do_nothing(index_elements=["source"])
            .returning(watermarks.c.source)
        )
    else:
        statement = (
            update(watermarks)
            .where(watermarks.c.source == source, watermarks.c.high_water == expected)
            .values(high_water=new, updated_at=now)
            .returning(watermarks.c.source)
        )
    if connection.execute(statement).first() is None:
        raise WatermarkConflict(source)


def reset(connection: Connection, source: str, *, to: datetime | None, now: datetime) -> None:
    """Set the watermark to `to`, or remove it (the next run reads everything) when None."""
    if to is None:
        connection.execute(delete(watermarks).where(watermarks.c.source == source))
        return
    statement = pg_insert(watermarks).values(source=source, high_water=to, updated_at=now)
    connection.execute(
        statement.on_conflict_do_update(
            index_elements=["source"],
            set_={"high_water": statement.excluded.high_water, "updated_at": now},
        )
    )
