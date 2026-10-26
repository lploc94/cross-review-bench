"""What every command shares: the lazily built context and the error-to-exit-code handling."""

import functools
from collections.abc import Callable
from datetime import date

import typer

from etl.api.context import AppContext
from etl.errors import EXIT_UNEXPECTED, EtlError, describe_error, exit_code_for
from etl.logging import get_logger

log = get_logger(__name__)

ContextFactory = Callable[[], AppContext]


class LazyContext:
    """Builds the AppContext on first use, so `--help` and argument errors need no database
    and no configuration."""

    def __init__(self, factory: ContextFactory) -> None:
        self._factory = factory
        self._context: AppContext | None = None

    def get(self) -> AppContext:
        if self._context is None:
            self._context = self._factory()
        return self._context

    def close(self) -> None:
        if self._context is not None:
            self._context.close()
            self._context = None


def app_context(ctx: typer.Context) -> AppContext:
    lazy = ctx.find_object(LazyContext)
    if lazy is None:
        raise RuntimeError("the etl command group did not set up its context")
    return lazy.get()


def guarded[**P](command: Callable[P, None]) -> Callable[P, None]:
    """Turn errors into a message on standard error and the error's exit code.

    EtlErrors map through etl.errors.EXIT_CODES; anything else exits with EXIT_UNEXPECTED and
    a description that never includes row values.
    """

    @functools.wraps(command)
    def wrapper(*args: P.args, **kwargs: P.kwargs) -> None:
        try:
            command(*args, **kwargs)
        except EtlError as error:
            typer.echo(f"error: {error}", err=True)
            if error.run_id is not None:
                typer.echo(f"see: etl runs show {error.run_id}", err=True)
            raise typer.Exit(exit_code_for(error)) from None
        except (typer.Exit, typer.Abort, typer.TyperException):
            # Exits, aborts and usage errors are the CLI's own answers; let them through.
            raise
        except Exception as error:
            description = describe_error(error)
            log.error("command.failed", error=description, error_type=type(error).__name__)
            typer.echo(f"error: {description}", err=True)
            raise typer.Exit(EXIT_UNEXPECTED) from None

    return wrapper


def parse_day(value: str | None, option: str) -> date | None:
    return require_day(value, option) if value is not None else None


def require_day(value: str, option: str) -> date:
    try:
        return date.fromisoformat(value)
    except ValueError:
        raise typer.BadParameter(
            f"{value!r} is not a date (YYYY-MM-DD)", param_hint=option
        ) from None
