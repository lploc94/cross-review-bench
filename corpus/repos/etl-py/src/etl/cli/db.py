"""`etl db check`, `etl db upgrade` and `etl settings`."""

from pathlib import Path
from typing import Annotated

import typer

from etl.api import database as database_api
from etl.api import settings as settings_api
from etl.cli.common import app_context, guarded
from etl.cli.output import echo_json, render_table
from etl.infra.migrations import DEFAULT_CONFIG
from etl.schemas.views import DatabaseView

db_app = typer.Typer(help="The database and its schema.", no_args_is_help=True)

ConfigOption = Annotated[
    Path, typer.Option("--config", help="Alembic configuration file (names the migrations).")
]


def describe_database(view: DatabaseView) -> str:
    state = "up to date" if view.up_to_date else "NOT up to date"
    return "\n".join(
        [
            f"PostgreSQL {view.server_version}",
            f"  schema revision  {view.current_revision or 'none'} ({state})",
            f"  code needs       {view.head_revision or 'none'}",
        ]
    )


@db_app.command("check")
@guarded
def check_command(
    ctx: typer.Context,
    config: ConfigOption = DEFAULT_CONFIG,
    as_json: Annotated[bool, typer.Option("--json", help="Print JSON.")] = False,
) -> None:
    """Check that the database is reachable and its schema is current."""
    view = database_api.check_database(app_context(ctx), config)
    if as_json:
        echo_json(view)
    else:
        typer.echo(describe_database(view))
    database_api.require_current_schema(view)


@db_app.command("upgrade")
@guarded
def upgrade_command(ctx: typer.Context, config: ConfigOption = DEFAULT_CONFIG) -> None:
    """Apply the migrations the database lacks."""
    view = database_api.upgrade_database(app_context(ctx), config)
    typer.echo(describe_database(view))


def register(app: typer.Typer) -> None:
    @app.command("settings")
    @guarded
    def settings_command(
        ctx: typer.Context,
        as_json: Annotated[bool, typer.Option("--json", help="Print JSON.")] = False,
    ) -> None:
        """Show the effective configuration (the database password is masked)."""
        view = settings_api.show_settings(app_context(ctx))
        if as_json:
            echo_json(view)
            return
        rows = [[name.upper(), str(value)] for name, value in view.model_dump().items()]
        typer.echo(render_table(["variable", "value"], rows))
