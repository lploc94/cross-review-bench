"""Declarative data-quality checks on warehouse tables.

A check counts offending rows (or, for a row-count delta, the rows themselves) with one query
inside the run's transaction, so it sees the data the run is about to commit. Details name
columns and counts, never values: offending values may be personal data.
"""

from __future__ import annotations

from collections.abc import Collection
from dataclasses import dataclass
from decimal import Decimal
from enum import StrEnum
from typing import Protocol

from sqlalchemy import ColumnElement, Connection, Table, and_, exists, func, not_, select


class Severity(StrEnum):
    ERROR = "error"  # a failure fails the run and rolls the load back
    WARN = "warn"  # a failure is recorded; the run goes on


@dataclass(frozen=True, slots=True)
class CheckOutcome:
    passed: bool
    observed: Decimal | None
    details: str


class CheckHistory(Protocol):
    def previous_observed(self, check_name: str) -> Decimal | None:
        """What the check observed after the latest successful run, if any."""
        ...


class Check(Protocol):
    @property
    def name(self) -> str: ...

    @property
    def table(self) -> Table: ...

    @property
    def severity(self) -> Severity: ...

    @property
    def description(self) -> str: ...

    def evaluate(self, connection: Connection, history: CheckHistory) -> CheckOutcome: ...


def _count(connection: Connection, table: Table, *conditions: ColumnElement[bool]) -> int:
    statement = select(func.count()).select_from(table)
    if conditions:
        statement = statement.where(and_(*conditions))
    return int(connection.execute(statement).scalar_one())


def _plural(count: int, noun: str) -> str:
    return f"{count} {noun}" if count == 1 else f"{count} {noun}s"


@dataclass(frozen=True, slots=True, eq=False)
class NotNull:
    table: Table
    column: str
    severity: Severity = Severity.ERROR

    @property
    def name(self) -> str:
        return f"{self.table.name}.{self.column}.not_null"

    @property
    def description(self) -> str:
        return f"{self.column} is never NULL"

    def evaluate(self, connection: Connection, history: CheckHistory) -> CheckOutcome:
        offending = _count(connection, self.table, self.table.c[self.column].is_(None))
        return CheckOutcome(
            passed=offending == 0,
            observed=Decimal(offending),
            details=f"{_plural(offending, 'row')} with NULL {self.column}",
        )


@dataclass(frozen=True, slots=True, eq=False)
class Unique:
    table: Table
    columns: tuple[str, ...]
    severity: Severity = Severity.ERROR
    # Restricts the rows that must be unique (the current versions of a type 2 dimension).
    where: ColumnElement[bool] | None = None
    label: str = "unique"

    @property
    def name(self) -> str:
        return f"{self.table.name}.{'+'.join(self.columns)}.{self.label}"

    @property
    def description(self) -> str:
        scope = " among current rows" if self.where is not None else ""
        return f"no two rows share {', '.join(self.columns)}{scope}"

    def evaluate(self, connection: Connection, history: CheckHistory) -> CheckOutcome:
        key = [self.table.c[name] for name in self.columns]
        groups = select(*key).group_by(*key).having(func.count() > 1)
        if self.where is not None:
            groups = groups.where(self.where)
        duplicated = int(
            connection.execute(select(func.count()).select_from(groups.subquery())).scalar_one()
        )
        return CheckOutcome(
            passed=duplicated == 0,
            observed=Decimal(duplicated),
            details=f"{_plural(duplicated, 'duplicated key')}",
        )


@dataclass(frozen=True, slots=True, eq=False)
class AcceptedValues:
    table: Table
    column: str
    values: Collection[str]
    severity: Severity = Severity.ERROR

    @property
    def name(self) -> str:
        return f"{self.table.name}.{self.column}.accepted_values"

    @property
    def description(self) -> str:
        return f"{self.column} is NULL or one of {len(self.values)} accepted values"

    def evaluate(self, connection: Connection, history: CheckHistory) -> CheckOutcome:
        column = self.table.c[self.column]
        offending = _count(
            connection,
            self.table,
            column.is_not(None),
            not_(column.in_(sorted(self.values))),
        )
        return CheckOutcome(
            passed=offending == 0,
            observed=Decimal(offending),
            details=f"{_plural(offending, 'row')} with an unexpected {self.column}",
        )


@dataclass(frozen=True, slots=True, eq=False)
class Referential:
    """Every non-NULL value of `column` exists in `parent.parent_column`."""

    table: Table
    column: str
    parent: Table
    parent_column: str
    severity: Severity = Severity.ERROR

    @property
    def name(self) -> str:
        return f"{self.table.name}.{self.column}.references_{self.parent.name}"

    @property
    def description(self) -> str:
        return f"every {self.column} exists in {self.parent.name}.{self.parent_column}"

    def evaluate(self, connection: Connection, history: CheckHistory) -> CheckOutcome:
        column = self.table.c[self.column]
        known = exists().where(self.parent.c[self.parent_column] == column)
        offending = _count(connection, self.table, column.is_not(None), not_(known))
        return CheckOutcome(
            passed=offending == 0,
            observed=Decimal(offending),
            details=(
                f"{_plural(offending, 'row')} whose {self.column} is missing from "
                f"{self.parent.name}"
            ),
        )


@dataclass(frozen=True, slots=True, eq=False)
class RowCountDelta:
    """The row count moved by at most `tolerance` (a fraction) since the previous successful
    run. Without a previous count, or from an empty table, there is nothing to compare."""

    table: Table
    tolerance: Decimal
    severity: Severity = Severity.WARN
    where: ColumnElement[bool] | None = None
    label: str = "row_count_delta"

    @property
    def name(self) -> str:
        return f"{self.table.name}.{self.label}"

    @property
    def description(self) -> str:
        return f"row count within {self.tolerance:.0%} of the previous successful run"

    def evaluate(self, connection: Connection, history: CheckHistory) -> CheckOutcome:
        conditions = [self.where] if self.where is not None else []
        current = _count(connection, self.table, *conditions)
        observed = Decimal(current)
        previous = history.previous_observed(self.name)
        if previous is None or previous == 0:
            return CheckOutcome(True, observed, f"{_plural(current, 'row')}, no baseline")
        delta = abs(observed - previous) / previous
        return CheckOutcome(
            passed=delta <= self.tolerance,
            observed=observed,
            details=f"{_plural(current, 'row')}, {delta:.1%} change from {previous}",
        )
