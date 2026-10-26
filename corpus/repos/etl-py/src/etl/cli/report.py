"""`etl report daily-sales` and `etl report customers`."""

from typing import Annotated

import typer

from etl.api import reports as reports_api
from etl.cli.common import app_context, guarded, parse_day
from etl.cli.output import echo_json, render_table
from etl.reports import customers, daily_sales
from etl.reports.writer import customer_count_cells, daily_sales_cells

report_app = typer.Typer(
    help="Reports, written as CSV to the report directory.", no_args_is_help=True
)


@report_app.command("daily-sales")
@guarded
def daily_sales_command(
    ctx: typer.Context,
    first: Annotated[
        str | None, typer.Option("--from", help="First day, YYYY-MM-DD (default: --to).")
    ] = None,
    last: Annotated[
        str | None, typer.Option("--to", help="Last day, YYYY-MM-DD (default: yesterday).")
    ] = None,
    as_json: Annotated[bool, typer.Option("--json", help="Print JSON.")] = False,
) -> None:
    """Orders and revenue per day, country and currency (days in the reporting zone)."""
    report = reports_api.daily_sales_report(
        app_context(ctx), first=parse_day(first, "--from"), last=parse_day(last, "--to")
    )
    if as_json:
        echo_json(report)
        return
    typer.echo(
        f"daily sales {report.first_day} to {report.last_day} ({report.zone}), "
        f"cancelled orders excluded"
    )
    typer.echo(render_table(daily_sales.HEADER, daily_sales_cells(report.rows), right=(3, 4)))
    typer.echo(f"written to {report.path}")


@report_app.command("customers")
@guarded
def customers_command(
    ctx: typer.Context,
    as_of: Annotated[
        str | None,
        typer.Option("--as-of", help="Count at the end of this day, YYYY-MM-DD (default: now)."),
    ] = None,
    as_json: Annotated[bool, typer.Option("--json", help="Print JSON.")] = False,
) -> None:
    """Customers per country."""
    report = reports_api.customer_counts_report(app_context(ctx), as_of=parse_day(as_of, "--as-of"))
    if as_json:
        echo_json(report)
        return
    moment = f"end of {report.as_of} ({report.zone})" if report.as_of else "current"
    typer.echo(f"customers per country, {moment}")
    typer.echo(render_table(customers.HEADER, customer_count_cells(report.rows), right=(1,)))
    typer.echo(f"total {report.total}")
    typer.echo(f"written to {report.path}")
