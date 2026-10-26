"""Rejected rows in `etl.rejects`, kept with their reason and what could be recovered."""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from datetime import datetime
from typing import Any

from sqlalchemy import Connection, delete, func, insert, select

from etl.infra.tables import rejects


@dataclass(frozen=True, slots=True)
class Reject:
    line_no: int
    reason: str
    column: str | None
    payload: Any


@dataclass(frozen=True, slots=True)
class RejectReason:
    reason: str
    count: int
    first_line_no: int


def insert_many(
    connection: Connection,
    *,
    run_id: int,
    source: str,
    items: Sequence[Reject],
    created_at: datetime,
) -> None:
    if not items:
        return
    connection.execute(
        insert(rejects),
        [
            {
                "run_id": run_id,
                "source": source,
                "line_no": item.line_no,
                "column_name": item.column,
                "reason": item.reason,
                "payload": item.payload,
                "created_at": created_at,
            }
            for item in items
        ],
    )


def for_run(
    connection: Connection,
    run_id: int,
    *,
    reason: str | None = None,
    after_line_no: int | None = None,
    limit: int = 100,
) -> list[Reject]:
    """Rejects of a run in file order; `after_line_no` continues a previous page."""
    statement = (
        select(rejects)
        .where(rejects.c.run_id == run_id)
        .order_by(rejects.c.line_no, rejects.c.id)
        .limit(limit)
    )
    if reason is not None:
        statement = statement.where(rejects.c.reason == reason)
    if after_line_no is not None:
        statement = statement.where(rejects.c.line_no > after_line_no)
    rows = connection.execute(statement).mappings()
    return [
        Reject(row["line_no"], row["reason"], row["column_name"], row["payload"]) for row in rows
    ]


def delete_before(connection: Connection, *, before: datetime, source: str | None = None) -> int:
    """Delete rejects recorded before `before` (of one source, when given); return how many."""
    statement = delete(rejects).where(rejects.c.created_at < before)
    if source is not None:
        statement = statement.where(rejects.c.source == source)
    return connection.execute(statement).rowcount


def reasons(connection: Connection, run_id: int) -> list[RejectReason]:
    """Rejects of a run grouped by reason, the most frequent first."""
    occurrences = func.count().label("occurrences")
    first = func.min(rejects.c.line_no).label("first_line_no")
    rows = connection.execute(
        select(rejects.c.reason, occurrences, first)
        .where(rejects.c.run_id == run_id)
        .group_by(rejects.c.reason)
        .order_by(occurrences.desc(), first)
    )
    return [RejectReason(row.reason, int(row.occurrences), int(row.first_line_no)) for row in rows]
