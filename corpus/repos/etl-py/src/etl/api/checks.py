"""Operations on data-quality checks: the declared checks, their latest results, and an
evaluation of the warehouse as it is now."""

from __future__ import annotations

from collections.abc import Sequence

from sqlalchemy import text

from etl.api.context import AppContext
from etl.quality.checks import Check
from etl.quality.registry import checks_for
from etl.quality.runner import run_checks
from etl.schemas.views import CheckResultView, CheckView
from etl.sources.registry import get_source
from etl.store import check_results
from etl.store.check_results import SucceededRunHistory


def _declared(context: AppContext, source: str | None) -> Sequence[Check]:
    if source is None:
        return list(context.checks)
    spec = get_source(source, context.sources)
    tables = context.datasets[spec.dataset].loader.target_tables
    return checks_for(tables, context.checks)


def list_checks(context: AppContext, source: str | None = None) -> list[CheckView]:
    """Every declared check (only those on the tables `source` loads, when given), with the
    result of its latest evaluation."""
    declared = _declared(context, source)
    with context.engine.connect() as connection:
        latest = check_results.latest_per_check(connection)
    views = []
    for check in declared:
        stored = latest.get(check.name)
        views.append(
            CheckView(
                name=check.name,
                table=check.table.name,
                severity=check.severity,
                description=check.description,
                last_passed=stored.result.passed if stored else None,
                last_run_id=stored.run_id if stored else None,
                last_details=stored.result.details if stored else None,
            )
        )
    return views


def evaluate_checks(context: AppContext, source: str | None = None) -> list[CheckResultView]:
    """Evaluate the declared checks against the committed warehouse data, outside any run.

    The checks run in a read-only transaction and their results are not recorded: row-count
    deltas keep comparing with what the last successful run observed.
    """
    declared = _declared(context, source)
    with context.engine.connect() as connection:
        connection.execute(text("SET TRANSACTION READ ONLY"))
        results = run_checks(connection, declared, SucceededRunHistory(connection))
        connection.rollback()
    return [CheckResultView.of(result) for result in results]
