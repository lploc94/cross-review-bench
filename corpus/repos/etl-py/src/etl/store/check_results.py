"""Check results in `etl.check_results`."""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from datetime import datetime
from decimal import Decimal
from typing import Any

from sqlalchemy import Connection, Row, insert, select
from sqlalchemy.dialects.postgresql import distinct_on

from etl.infra.tables import check_results, runs
from etl.quality.checks import Severity
from etl.quality.runner import CheckResult
from etl.store.runs import RunStatus


@dataclass(frozen=True, slots=True)
class StoredCheckResult:
    run_id: int
    result: CheckResult
    checked_at: datetime


def save(
    connection: Connection,
    *,
    run_id: int,
    results: Sequence[CheckResult],
    checked_at: datetime,
) -> None:
    if not results:
        return
    connection.execute(
        insert(check_results),
        [
            {
                "run_id": run_id,
                "check_name": result.check_name,
                "table_name": result.table_name,
                "severity": result.severity,
                "passed": result.passed,
                "observed": result.observed,
                "details": result.details,
                "checked_at": checked_at,
            }
            for result in results
        ],
    )


def _stored(row: Row[Any]) -> StoredCheckResult:
    mapping = row._mapping
    return StoredCheckResult(
        run_id=mapping["run_id"],
        result=CheckResult(
            check_name=mapping["check_name"],
            table_name=mapping["table_name"],
            severity=Severity(mapping["severity"]),
            passed=mapping["passed"],
            observed=mapping["observed"],
            details=mapping["details"],
        ),
        checked_at=mapping["checked_at"],
    )


def for_run(connection: Connection, run_id: int) -> list[StoredCheckResult]:
    rows = connection.execute(
        select(check_results).where(check_results.c.run_id == run_id).order_by(check_results.c.id)
    )
    return [_stored(row) for row in rows]


def latest_per_check(connection: Connection) -> dict[str, StoredCheckResult]:
    """The most recent result of every check that has run, failed runs included."""
    rows = connection.execute(
        select(check_results)
        .ext(distinct_on(check_results.c.check_name))
        .order_by(
            check_results.c.check_name,
            check_results.c.run_id.desc(),
            check_results.c.id.desc(),
        )
    )
    latest = (_stored(row) for row in rows)
    return {stored.result.check_name: stored for stored in latest}


class SucceededRunHistory:
    """CheckHistory over the results of runs that succeeded: a failed run's observations
    were rolled back with its load and are no baseline."""

    def __init__(self, connection: Connection) -> None:
        self._connection = connection

    def previous_observed(self, check_name: str) -> Decimal | None:
        observed = self._connection.execute(
            select(check_results.c.observed)
            .join(runs, runs.c.id == check_results.c.run_id)
            .where(
                check_results.c.check_name == check_name,
                runs.c.status == RunStatus.SUCCEEDED,
            )
            .order_by(check_results.c.run_id.desc(), check_results.c.id.desc())
            .limit(1)
        ).scalar_one_or_none()
        return Decimal(observed) if observed is not None else None
