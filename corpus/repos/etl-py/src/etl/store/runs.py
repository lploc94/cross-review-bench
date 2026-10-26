"""Run records in `etl.runs`."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from enum import StrEnum

from sqlalchemy import Connection, RowMapping, insert, select, update

from etl.infra.tables import runs


class RunStatus(StrEnum):
    RUNNING = "running"
    SUCCEEDED = "succeeded"
    FAILED = "failed"


@dataclass(frozen=True, slots=True)
class RunCounts:
    read: int = 0
    skipped: int = 0
    loaded: int = 0
    rejected: int = 0


@dataclass(frozen=True, slots=True)
class RunRecord:
    id: int
    source: str
    path: str
    status: RunStatus
    started_at: datetime
    finished_at: datetime | None
    rows_read: int
    rows_skipped: int
    rows_loaded: int
    rows_rejected: int
    error: str | None

    @classmethod
    def from_row(cls, row: RowMapping) -> RunRecord:
        return cls(
            id=row["id"],
            source=row["source"],
            path=row["path"],
            status=RunStatus(row["status"]),
            started_at=row["started_at"],
            finished_at=row["finished_at"],
            rows_read=row["rows_read"],
            rows_skipped=row["rows_skipped"],
            rows_loaded=row["rows_loaded"],
            rows_rejected=row["rows_rejected"],
            error=row["error"],
        )


ABANDONED = "abandoned: the process running it stopped before it finished"


def start(connection: Connection, *, source: str, path: str, started_at: datetime) -> int:
    run_id = connection.execute(
        insert(runs)
        .values(source=source, path=path, status=RunStatus.RUNNING, started_at=started_at)
        .returning(runs.c.id)
    ).scalar_one()
    return int(run_id)


def finish(
    connection: Connection,
    run_id: int,
    *,
    status: RunStatus,
    finished_at: datetime,
    counts: RunCounts,
    error: str | None = None,
) -> None:
    if status is RunStatus.RUNNING:
        raise ValueError("a finished run is either succeeded or failed")
    updated = connection.execute(
        update(runs)
        .where(runs.c.id == run_id, runs.c.status == RunStatus.RUNNING)
        .values(
            status=status,
            finished_at=finished_at,
            rows_read=counts.read,
            rows_skipped=counts.skipped,
            rows_loaded=counts.loaded,
            rows_rejected=counts.rejected,
            error=error,
        )
        .returning(runs.c.id)
    ).first()
    if updated is None:
        raise RuntimeError(f"run {run_id} is not running")


def abandon_running(connection: Connection, *, source: str, now: datetime) -> list[int]:
    """Mark the source's runs still `running` as failed and return their ids.

    Only call this while holding the source's run lock: no live run can then exist, so a
    `running` record belongs to a process that died before it could finish it.
    """
    rows = connection.execute(
        update(runs)
        .where(runs.c.source == source, runs.c.status == RunStatus.RUNNING)
        .values(status=RunStatus.FAILED, finished_at=now, error=ABANDONED)
        .returning(runs.c.id)
    ).scalars()
    return sorted(int(run_id) for run_id in rows)


def get(connection: Connection, run_id: int) -> RunRecord | None:
    row = connection.execute(select(runs).where(runs.c.id == run_id)).mappings().first()
    return RunRecord.from_row(row) if row is not None else None


def list_runs(
    connection: Connection,
    *,
    source: str | None = None,
    status: RunStatus | None = None,
    limit: int = 20,
) -> list[RunRecord]:
    """Runs, newest first."""
    statement = select(runs).order_by(runs.c.started_at.desc(), runs.c.id.desc()).limit(limit)
    if source is not None:
        statement = statement.where(runs.c.source == source)
    if status is not None:
        statement = statement.where(runs.c.status == status)
    return [RunRecord.from_row(row) for row in connection.execute(statement).mappings()]


def latest(connection: Connection, source: str) -> RunRecord | None:
    """The source's most recent run, whatever its status."""
    row = (
        connection.execute(
            select(runs).where(runs.c.source == source).order_by(runs.c.id.desc()).limit(1)
        )
        .mappings()
        .first()
    )
    return RunRecord.from_row(row) if row is not None else None


def last_succeeded(connection: Connection, source: str) -> RunRecord | None:
    row = (
        connection.execute(
            select(runs)
            .where(runs.c.source == source, runs.c.status == RunStatus.SUCCEEDED)
            .order_by(runs.c.id.desc())
            .limit(1)
        )
        .mappings()
        .first()
    )
    return RunRecord.from_row(row) if row is not None else None
