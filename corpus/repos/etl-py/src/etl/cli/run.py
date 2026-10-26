"""`etl run <source> <path>`: load one file."""

from pathlib import Path
from typing import Annotated

import typer

from etl.api import runs as runs_api
from etl.cli.common import app_context, guarded
from etl.cli.output import echo_json, format_time
from etl.schemas.views import RunView


def describe_run(view: RunView) -> str:
    lines = [
        f"run {view.id}: {view.source} {view.status}",
        f"  file      {view.path}",
        f"  started   {format_time(view.started_at)}",
        f"  finished  {format_time(view.finished_at)}",
        f"  read      {view.rows_read}",
        f"  skipped   {view.rows_skipped}  (at or before the watermark minus the lookback)",
        f"  loaded    {view.rows_loaded}",
        f"  rejected  {view.rows_rejected}",
    ]
    if view.error:
        lines.append(f"  error     {view.error}")
    return "\n".join(lines)


def register(app: typer.Typer) -> None:
    @app.command("run")
    @guarded
    def run_command(
        ctx: typer.Context,
        source: Annotated[str, typer.Argument(help="Source name, e.g. orders.")],
        path: Annotated[Path, typer.Argument(help="Export file (plain or gzip).")],
        as_json: Annotated[bool, typer.Option("--json", help="Print the run as JSON.")] = False,
    ) -> None:
        """Load one export file of a source into the warehouse."""
        view = runs_api.run_source(app_context(ctx), source, path)
        if as_json:
            echo_json(view)
        else:
            typer.echo(describe_run(view))
