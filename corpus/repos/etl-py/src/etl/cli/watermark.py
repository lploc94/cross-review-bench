"""`etl watermark list`, `etl watermark show <source>` and `etl watermark reset <source>`."""

from datetime import datetime
from typing import Annotated

import typer

from etl.api import watermarks as watermarks_api
from etl.cli.common import app_context, guarded
from etl.cli.output import echo_json, format_time, render_table
from etl.schemas.views import WatermarkView

watermark_app = typer.Typer(help="Incremental-load watermarks.", no_args_is_help=True)


def describe_watermark(view: WatermarkView) -> str:
    if view.high_water is None:
        return f"{view.source}: no watermark, the next run reads every row"
    return "\n".join(
        [
            f"{view.source}",
            f"  high water  {format_time(view.high_water)}",
            f"  lookback    {view.lookback}",
            f"  next run    rows updated after {format_time(view.cutoff)}",
            f"  set at      {format_time(view.updated_at)}",
        ]
    )


def _parse_instant(value: str | None) -> datetime | None:
    if value is None:
        return None
    try:
        return datetime.fromisoformat(value)
    except ValueError:
        raise typer.BadParameter(
            f"{value!r} is not an ISO 8601 timestamp", param_hint="--to"
        ) from None


@watermark_app.command("list")
@guarded
def list_command(
    ctx: typer.Context,
    as_json: Annotated[bool, typer.Option("--json", help="Print JSON.")] = False,
) -> None:
    """List the watermark of every source."""
    views = watermarks_api.list_watermarks(app_context(ctx))
    if as_json:
        echo_json(views)
        return
    rows = [
        [view.source, format_time(view.high_water), str(view.lookback), format_time(view.cutoff)]
        for view in views
    ]
    typer.echo(render_table(["source", "high water", "lookback", "next run after"], rows))


@watermark_app.command("show")
@guarded
def show_command(
    ctx: typer.Context,
    source: Annotated[str, typer.Argument(help="Source name.")],
    as_json: Annotated[bool, typer.Option("--json", help="Print JSON.")] = False,
) -> None:
    """Show a source's watermark and the window of its next run."""
    view = watermarks_api.show_watermark(app_context(ctx), source)
    if as_json:
        echo_json(view)
    else:
        typer.echo(describe_watermark(view))


@watermark_app.command("reset")
@guarded
def reset_command(
    ctx: typer.Context,
    source: Annotated[str, typer.Argument(help="Source name.")],
    to: Annotated[
        str | None,
        typer.Option(help="New watermark with its offset, e.g. 2026-03-01T00:00:00Z."),
    ] = None,
    yes: Annotated[bool, typer.Option("--yes", help="Do not ask for confirmation.")] = False,
) -> None:
    """Remove a watermark (the next run reads every row), or move it with --to."""
    instant = _parse_instant(to)
    target = format_time(instant) if instant is not None else "nothing (full reload)"
    if not yes and not typer.confirm(f"Reset the {source} watermark to {target}?"):
        raise typer.Abort()
    view = watermarks_api.reset_watermark(app_context(ctx), source, instant)
    typer.echo(describe_watermark(view))
