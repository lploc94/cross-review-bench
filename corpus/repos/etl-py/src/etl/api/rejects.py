"""Operations on rejected rows: list a run's rejects, and delete old ones.

Rejects keep the raw values of the rows they refused, personal data included, so they are
listed without their values and deleted once they are older than the retention an operator
chooses.
"""

from __future__ import annotations

from datetime import date

from etl.api.context import AppContext
from etl.domain.timestamps import start_of_day
from etl.errors import InvalidRequest, RunNotFound
from etl.logging import get_logger
from etl.schemas.views import PruneView, RejectView
from etl.sources.registry import get_source
from etl.store import rejects, runs

MAX_PAGE = 1000

log = get_logger(__name__)


def list_rejects(
    context: AppContext,
    run_id: int,
    *,
    reason: str | None = None,
    after_line_no: int | None = None,
    limit: int = 50,
) -> list[RejectView]:
    if not 1 <= limit <= MAX_PAGE:
        raise InvalidRequest(f"limit must be between 1 and {MAX_PAGE}")
    if after_line_no is not None and after_line_no < 0:
        raise InvalidRequest("the line number to continue after must not be negative")
    with context.engine.connect() as connection:
        if runs.get(connection, run_id) is None:
            raise RunNotFound(run_id)
        items = rejects.for_run(
            connection, run_id, reason=reason, after_line_no=after_line_no, limit=limit
        )
    return [
        RejectView(line_no=item.line_no, column=item.column, reason=item.reason) for item in items
    ]


def prune_rejects(context: AppContext, *, before: date, source: str | None = None) -> PruneView:
    """Delete the rejects recorded before the start of `before` (a day in the reporting zone).

    The day must not lie after today, so the rejects recorded today are always kept.
    """
    zone = context.settings.reporting_tz
    today = context.clock.now().astimezone(zone).date()
    if before > today:
        raise InvalidRequest("the day to prune before must not lie in the future")
    name = get_source(source, context.sources).name if source is not None else None
    cutoff = start_of_day(before, zone)
    with context.engine.begin() as connection:
        deleted = rejects.delete_before(connection, before=cutoff, source=name)
    log.info("rejects.pruned", before=cutoff.isoformat(), source=name, deleted=deleted)
    return PruneView(before=cutoff, source=name, deleted=deleted)
