"""`etl checks list` and `etl checks run`."""

from typing import Annotated

import typer

from etl.api import checks as checks_api
from etl.cli.common import app_context, guarded
from etl.cli.output import echo_json, render_table
from etl.errors import QualityCheckFailed
from etl.quality.checks import Severity

checks_app = typer.Typer(help="Data-quality checks.", no_args_is_help=True)


def _last_result(passed: bool | None) -> str:
    if passed is None:
        return "never run"
    return "pass" if passed else "FAIL"


@checks_app.command("list")
@guarded
def list_command(
    ctx: typer.Context,
    source: Annotated[str | None, typer.Option(help="Only checks on this source's tables.")] = None,
    as_json: Annotated[bool, typer.Option("--json", help="Print JSON.")] = False,
) -> None:
    """List the declared checks and the result of their latest evaluation."""
    views = checks_api.list_checks(app_context(ctx), source)
    if as_json:
        echo_json(views)
        return
    rows = [
        [
            view.name,
            str(view.severity),
            _last_result(view.last_passed),
            str(view.last_run_id) if view.last_run_id is not None else "-",
            view.description,
        ]
        for view in views
    ]
    typer.echo(render_table(["check", "severity", "last result", "run", "description"], rows))


@checks_app.command("run")
@guarded
def run_command(
    ctx: typer.Context,
    source: Annotated[str | None, typer.Option(help="Only checks on this source's tables.")] = None,
    as_json: Annotated[bool, typer.Option("--json", help="Print JSON.")] = False,
) -> None:
    """Evaluate the checks against the warehouse as it is now, without recording results.

    Exits with the quality-check code when an error-level check fails.
    """
    results = checks_api.evaluate_checks(app_context(ctx), source)
    if as_json:
        echo_json(results)
    else:
        rows = [
            [
                result.check_name,
                str(result.severity),
                "pass" if result.passed else "FAIL",
                result.details,
            ]
            for result in results
        ]
        typer.echo(render_table(["check", "severity", "result", "details"], rows))
    failed = [r.check_name for r in results if not r.passed and r.severity is Severity.ERROR]
    if failed:
        raise QualityCheckFailed(failed)
