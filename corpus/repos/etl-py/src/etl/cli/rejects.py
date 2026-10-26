"""`etl rejects list <run-id>` and `etl rejects prune`."""

from typing import Annotated

import typer

from etl.api import rejects as rejects_api
from etl.cli.common import app_context, guarded, require_day
from etl.cli.output import echo_json, format_time, render_table

rejects_app = typer.Typer(help="Rejected rows.", no_args_is_help=True)


@rejects_app.command("list")
@guarded
def list_command(
    ctx: typer.Context,
    run_id: Annotated[int, typer.Argument(help="Run id.")],
    reason: Annotated[str | None, typer.Option(help="Only rejects with this reason.")] = None,
    after: Annotated[
        int | None, typer.Option("--after", help="Continue after this line number.")
    ] = None,
    limit: Annotated[int, typer.Option(help="At most this many rejects.")] = 50,
    as_json: Annotated[bool, typer.Option("--json", help="Print JSON.")] = False,
) -> None:
    """List a run's rejected rows in file order: line, column and reason, never values."""
    views = rejects_api.list_rejects(
        app_context(ctx), run_id, reason=reason, after_line_no=after, limit=limit
    )
    if as_json:
        echo_json(views)
        return
    if not views:
        typer.echo("no rejects")
        return
    rows = [[str(view.line_no), view.column or "-", view.reason] for view in views]
    typer.echo(render_table(["line", "column", "reason"], rows, right=(0,)))
    if len(views) == limit:
        typer.echo(f"more may follow: --after {views[-1].line_no}")


@rejects_app.command("prune")
@guarded
def prune_command(
    ctx: typer.Context,
    before: Annotated[
        str, typer.Option("--before", help="Delete rejects recorded before this day, YYYY-MM-DD.")
    ],
    source: Annotated[str | None, typer.Option(help="Only this source's rejects.")] = None,
    yes: Annotated[bool, typer.Option("--yes", help="Do not ask for confirmation.")] = False,
) -> None:
    """Delete old rejects (they keep raw rows, personal data included)."""
    day = require_day(before, "--before")
    scope = f"{source} rejects" if source is not None else "rejects of every source"
    if not yes and not typer.confirm(f"Delete {scope} recorded before {day}?"):
        raise typer.Abort()
    view = rejects_api.prune_rejects(app_context(ctx), before=day, source=source)
    typer.echo(f"deleted {view.deleted} rejects recorded before {format_time(view.before)}")
