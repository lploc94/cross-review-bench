"""The `etl` command (also `python -m etl`)."""

import typer

from etl.api.context import build_context
from etl.cli import db, run, sources
from etl.cli.checks import checks_app
from etl.cli.common import ContextFactory, LazyContext
from etl.cli.db import db_app
from etl.cli.rejects import rejects_app
from etl.cli.report import report_app
from etl.cli.runs import runs_app
from etl.cli.sources import sources_app
from etl.cli.watermark import watermark_app


def build_app(factory: ContextFactory = build_context) -> typer.Typer:
    """The command tree. `factory` builds the AppContext the first time a command needs it;
    tests pass one with their own settings, engine and clock."""
    app = typer.Typer(
        name="etl",
        help="Load retail source exports into the warehouse.",
        no_args_is_help=True,
        add_completion=False,
        pretty_exceptions_enable=False,
        rich_markup_mode=None,
    )

    @app.callback()
    def main_callback(ctx: typer.Context) -> None:
        lazy = LazyContext(factory)
        ctx.obj = lazy
        ctx.call_on_close(lazy.close)

    run.register(app)
    sources.register(app)
    db.register(app)
    app.add_typer(db_app, name="db")
    app.add_typer(runs_app, name="runs")
    app.add_typer(rejects_app, name="rejects")
    app.add_typer(sources_app, name="sources")
    app.add_typer(checks_app, name="checks")
    app.add_typer(report_app, name="report")
    app.add_typer(watermark_app, name="watermark")
    return app


def main() -> None:
    build_app()()
