"""`etl runs list` and `etl runs show <id>`."""

from typing import Annotated

import typer

from etl.api import runs as runs_api
from etl.cli.common import app_context, guarded
from etl.cli.output import echo_json, format_time, render_table
from etl.cli.run import describe_run
from etl.store.runs import RunStatus

runs_app = typer.Typer(help="Inspect runs.", no_args_is_help=True)


@runs_app.command("list")
@guarded
def list_command(
    ctx: typer.Context,
    source: Annotated[str | None, typer.Option(help="Only runs of this source.")] = None,
    status: Annotated[RunStatus | None, typer.Option(help="Only runs in this status.")] = None,
    limit: Annotated[int, typer.Option(help="At most this many runs.")] = 20,
    as_json: Annotated[bool, typer.Option("--json", help="Print JSON.")] = False,
) -> None:
    """List runs, newest first."""
    views = runs_api.list_runs(app_context(ctx), source=source, status=status, limit=limit)
    if as_json:
        echo_json(views)
        return
    if not views:
        typer.echo("no runs")
        return
    rows = [
        [
            str(view.id),
            view.source,
            str(view.status),
            format_time(view.started_at),
            format_time(view.finished_at),
            str(view.rows_read),
            str(view.rows_loaded),
            str(view.rows_rejected),
        ]
        for view in views
    ]
    header = ["id", "source", "status", "started", "finished", "read", "loaded", "rejected"]
    typer.echo(render_table(header, rows, right=(0, 5, 6, 7)))


@runs_app.command("show")
@guarded
def show_command(
    ctx: typer.Context,
    run_id: Annotated[int, typer.Argument(help="Run id.")],
    as_json: Annotated[bool, typer.Option("--json", help="Print JSON.")] = False,
) -> None:
    """Show a run with its check results and reject reasons."""
    detail = runs_api.show_run(app_context(ctx), run_id)
    if as_json:
        echo_json(detail)
        return
    parts = [describe_run(detail.run)]
    if detail.checks:
        rows = [
            [
                check.check_name,
                str(check.severity),
                "pass" if check.passed else "FAIL",
                check.details,
            ]
            for check in detail.checks
        ]
        parts.append("\nchecks\n" + render_table(["check", "severity", "result", "details"], rows))
    if detail.reject_reasons:
        rows = [
            [reason.reason, str(reason.count), str(reason.first_line_no)]
            for reason in detail.reject_reasons
        ]
        parts.append(
            "\nrejects\n" + render_table(["reason", "rows", "first line"], rows, right=(1, 2))
        )
    typer.echo("\n".join(parts))
