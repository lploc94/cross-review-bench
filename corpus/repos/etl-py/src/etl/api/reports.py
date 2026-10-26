"""Report operations: build a report, write it as CSV to the report directory, return it."""

from __future__ import annotations

from datetime import date, timedelta

from etl.api.context import AppContext
from etl.domain.timestamps import local_date, start_of_day
from etl.errors import InvalidRequest
from etl.reports import customers, daily_sales
from etl.reports.writer import customer_count_cells, daily_sales_cells, write_csv
from etl.schemas.reports import CustomerCountsReport, DailySalesReport

MAX_REPORT_DAYS = 366


def _yesterday(context: AppContext) -> date:
    return local_date(context.clock.now(), context.settings.reporting_tz) - timedelta(days=1)


def daily_sales_report(
    context: AppContext, *, first: date | None = None, last: date | None = None
) -> DailySalesReport:
    """Daily sales from `first` to `last` (inclusive). `last` defaults to yesterday in the
    reporting zone, `first` to `last`."""
    zone = context.settings.reporting_tz
    last_day = last if last is not None else _yesterday(context)
    first_day = first if first is not None else last_day
    if last_day < first_day:
        raise InvalidRequest("--to is before --from")
    if (last_day - first_day).days >= MAX_REPORT_DAYS:
        raise InvalidRequest(f"a report covers at most {MAX_REPORT_DAYS} days")
    with context.engine.connect() as connection:
        rows = daily_sales.daily_sales(connection, first=first_day, last=last_day, zone=zone)
    path = context.settings.report_dir / f"daily_sales_{first_day}_{last_day}.csv"
    write_csv(path, daily_sales.HEADER, daily_sales_cells(rows))
    return DailySalesReport(
        first_day=first_day, last_day=last_day, zone=zone.key, rows=rows, path=path
    )


def customer_counts_report(
    context: AppContext, *, as_of: date | None = None
) -> CustomerCountsReport:
    """Customers per country, as they stood at the end of `as_of` in the reporting zone, or
    now when `as_of` is None."""
    zone = context.settings.reporting_tz
    if as_of is not None and as_of > local_date(context.clock.now(), zone):
        raise InvalidRequest("--as-of is in the future")
    before = start_of_day(as_of + timedelta(days=1), zone) if as_of is not None else None
    with context.engine.connect() as connection:
        rows = customers.customer_counts(connection, before=before)
    suffix = as_of.isoformat() if as_of is not None else "current"
    path = context.settings.report_dir / f"customer_counts_{suffix}.csv"
    write_csv(path, customers.HEADER, customer_count_cells(rows))
    return CustomerCountsReport(as_of=as_of, zone=zone.key, rows=rows, path=path)
