"""`etl sources list|show` and `etl status`."""

from typing import Annotated

import typer

from etl.api import sources as sources_api
from etl.cli.common import app_context, guarded
from etl.cli.output import echo_json, format_time, render_table
from etl.schemas.views import SourceView

sources_app = typer.Typer(help="Declared sources.", no_args_is_help=True)


def describe_source(view: SourceView) -> str:
    if view.file_format == "csv":
        layout = (
            f"csv, delimiter {view.delimiter!r}, decimal separator {view.decimal_separator!r},"
            f" {view.encoding}"
        )
    else:
        layout = f"JSON Lines, {view.encoding}"
    formats = " or ".join(view.timestamp_formats) or "ISO 8601"
    lines = [
        f"{view.name}: {view.description}" if view.description else view.name,
        f"  dataset          {view.dataset}",
        f"  format           {layout} (plain or gzip)",
        f"  timestamps       {formats}; naive ones in {view.zone}",
        f"  ambiguous times  {view.ambiguous_times}",
        f"  lookback         {view.lookback}",
        f"  required         {', '.join(view.required_columns)}",
        f"  optional         {', '.join(view.optional_columns) or '-'}",
    ]
    return "\n".join(lines)


@sources_app.command("list")
@guarded
def list_command(
    ctx: typer.Context,
    as_json: Annotated[bool, typer.Option("--json", help="Print JSON.")] = False,
) -> None:
    """List the declared sources."""
    views = sources_api.list_sources(app_context(ctx))
    if as_json:
        echo_json(views)
        return
    rows = [
        [view.name, view.dataset, view.file_format, view.zone, str(view.lookback)] for view in views
    ]
    typer.echo(render_table(["source", "dataset", "format", "zone", "lookback"], rows))


@sources_app.command("show")
@guarded
def show_command(
    ctx: typer.Context,
    source: Annotated[str, typer.Argument(help="Source name.")],
    as_json: Annotated[bool, typer.Option("--json", help="Print JSON.")] = False,
) -> None:
    """Show how a source's files are read."""
    view = sources_api.show_source(app_context(ctx), source)
    if as_json:
        echo_json(view)
    else:
        typer.echo(describe_source(view))


def register(app: typer.Typer) -> None:
    @app.command("status")
    @guarded
    def status_command(
        ctx: typer.Context,
        source: Annotated[str | None, typer.Option(help="Only this source.")] = None,
        as_json: Annotated[bool, typer.Option("--json", help="Print JSON.")] = False,
    ) -> None:
        """Per source: a run in progress, the watermark, the latest and last good run."""
        views = sources_api.source_status(app_context(ctx), source)
        if as_json:
            echo_json(views)
            return
        rows = [
            [
                view.source,
                "running" if view.running else "idle",
                format_time(view.high_water),
                f"{view.last_run_id} {view.last_status}" if view.last_run_id is not None else "-",
                str(view.last_succeeded_run_id) if view.last_succeeded_run_id is not None else "-",
                format_time(view.last_succeeded_at),
            ]
            for view in views
        ]
        header = ["source", "state", "watermark", "latest run", "last good", "succeeded at"]
        typer.echo(render_table(header, rows))
