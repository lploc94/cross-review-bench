"""What every dataset loader provides, and the staging tables they share."""

from __future__ import annotations

import dataclasses
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Protocol

from sqlalchemy import Column, Connection, Integer, MetaData, Table, func, select
from sqlalchemy.sql.dml import ReturningInsert, ReturningUpdate

from etl.domain.records import RejectedGroups


@dataclass(frozen=True, slots=True)
class LoadContext:
    """The run a load belongs to: every written row records its id and the load time."""

    run_id: int
    loaded_at: datetime


@dataclass(frozen=True, slots=True)
class LoadStats:
    inserted: int = 0
    updated: int = 0

    @property
    def written(self) -> int:
        return self.inserted + self.updated


@dataclass(frozen=True, slots=True)
class StagedReject:
    """A staged row a loader refuses after seeing the whole batch."""

    line_no: int
    reason: str
    column: str | None
    payload: dict[str, Any]


class Loader[R](Protocol):
    """Writes one dataset: rows are staged in a temporary table, then merged into the
    warehouse in the run's transaction."""

    @property
    def target_tables(self) -> tuple[Table, ...]:
        """The warehouse tables the loader writes; their quality checks run after the load."""
        ...

    def stage_table(self, metadata: MetaData) -> Table:
        """A fresh temporary staging table, dropped when the run's transaction ends."""
        ...

    def stage_row(self, record: R) -> dict[str, Any]: ...

    def remove_inconsistent(
        self, connection: Connection, stage: Table, rejected: RejectedGroups
    ) -> list[StagedReject]:
        """Delete staged rows that contradict other rows of the batch, or that belong to a
        version with a rejected row (`rejected`, for datasets whose versions span several
        rows), and return them."""
        ...

    def merge(self, connection: Connection, stage: Table, context: LoadContext) -> LoadStats:
        """Write the deduplicated batch into the warehouse, never replacing newer data."""
        ...


def temporary_table(name: str, metadata: MetaData, *columns: Column[Any]) -> Table:
    """A staging table: `line_no` plus the dataset's columns, temporary and dropped on commit.

    Temporary tables belong to the session, so concurrent runs never see each other's rows.
    """
    return Table(
        name,
        metadata,
        Column("line_no", Integer, nullable=False),
        *columns,
        prefixes=["TEMPORARY"],
        postgresql_on_commit="DROP",
    )


def count_written(
    connection: Connection, statement: ReturningInsert[Any] | ReturningUpdate[Any]
) -> int:
    """Run a data-modifying statement that has a RETURNING clause and count its rows.

    The count is taken in the database (WITH written AS (...) SELECT count(*)), which works
    for INSERT ... SELECT, where the driver reports no row count.
    """
    written = statement.cte("written")
    return int(connection.execute(select(func.count()).select_from(written)).scalar_one())


def record_values(record: object) -> dict[str, Any]:
    """A record dataclass as a column-name mapping for staging inserts."""
    if not dataclasses.is_dataclass(record) or isinstance(record, type):
        raise TypeError(f"expected a record dataclass, got {type(record).__name__}")
    return {field.name: getattr(record, field.name) for field in dataclasses.fields(record)}
