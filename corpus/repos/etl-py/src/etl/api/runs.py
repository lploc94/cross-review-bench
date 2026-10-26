"""Operations on runs: start one, list them, show one."""

from __future__ import annotations

from pathlib import Path

from etl.api.context import AppContext
from etl.errors import InvalidRequest, RunNotFound
from etl.schemas.views import CheckResultView, RejectReasonView, RunDetail, RunView
from etl.sources.registry import get_source
from etl.store import check_results, rejects, runs
from etl.store.runs import RunStatus

MAX_LIST_LIMIT = 1000


def run_source(context: AppContext, source: str, path: Path) -> RunView:
    """Load one file of `source` and return the finished run."""
    result = context.pipeline().run(source, path)
    with context.engine.connect() as connection:
        record = runs.get(connection, result.run_id)
    if record is None:
        raise RunNotFound(result.run_id)
    return RunView.of(record)


def list_runs(
    context: AppContext,
    *,
    source: str | None = None,
    status: RunStatus | None = None,
    limit: int = 20,
) -> list[RunView]:
    if source is not None:
        get_source(source, context.sources)
    if not 1 <= limit <= MAX_LIST_LIMIT:
        raise InvalidRequest(f"limit must be between 1 and {MAX_LIST_LIMIT}")
    with context.engine.connect() as connection:
        records = runs.list_runs(connection, source=source, status=status, limit=limit)
    return [RunView.of(record) for record in records]


def show_run(context: AppContext, run_id: int) -> RunDetail:
    with context.engine.connect() as connection:
        record = runs.get(connection, run_id)
        if record is None:
            raise RunNotFound(run_id)
        stored = check_results.for_run(connection, run_id)
        reasons = rejects.reasons(connection, run_id)
    return RunDetail(
        run=RunView.of(record),
        checks=[CheckResultView.of(item.result) for item in stored],
        reject_reasons=[
            RejectReasonView(
                reason=reason.reason, count=reason.count, first_line_no=reason.first_line_no
            )
            for reason in reasons
        ],
    )
