"""Errors the service reports to an operator, and the CLI exit code of each.

Every failure that ends a command is an EtlError subclass. `EXIT_CODES` is the one place that
maps them to process exit codes; the CLI looks codes up through `exit_code_for`.
"""

from __future__ import annotations

from collections.abc import Sequence

from sqlalchemy.exc import DBAPIError


class EtlError(Exception):
    """Base class of every failure the service reports to an operator.

    `run_id` is set by the pipeline when the failure ended a recorded run, so the CLI can name
    the run the operator should look at.
    """

    run_id: int | None = None


class ConfigError(EtlError):
    """The environment does not describe a usable configuration."""

    def __init__(self, problems: Sequence[str]) -> None:
        self.problems = list(problems)
        super().__init__("invalid configuration:\n" + "\n".join(f"  - {p}" for p in problems))


class InvalidRequest(EtlError):
    """A command was given arguments that cannot be served (an inverted date range, ...)."""


class NotFound(EtlError):
    """Something the operator named does not exist."""


class UnknownSource(NotFound):
    def __init__(self, name: str, known: Sequence[str]) -> None:
        self.name = name
        super().__init__(f"unknown source {name!r} (known sources: {', '.join(sorted(known))})")


class RunNotFound(NotFound):
    def __init__(self, run_id: int) -> None:
        self.missing_run_id = run_id
        super().__init__(f"run {run_id} does not exist")


class SourceFileNotFound(NotFound):
    def __init__(self, path: str) -> None:
        self.path = path
        super().__init__(f"source file {path} does not exist or is not a file")


class SourceFormatError(EtlError):
    """A source file cannot be read at all (bad compression, bad encoding, broken CSV quoting),
    or not safely (an order line that cannot be split into its fields, or whose order_id
    cannot be read).

    Single malformed rows are rejected instead; this error stops the whole run.
    """

    def __init__(self, message: str, *, line_no: int | None = None) -> None:
        self.line_no = line_no
        prefix = f"line {line_no}: " if line_no is not None else ""
        super().__init__(prefix + message)


class SchemaMismatch(EtlError):
    """A source file's columns do not match what its source declares."""

    def __init__(
        self,
        source: str,
        *,
        missing: Sequence[str] = (),
        duplicated: Sequence[str] = (),
    ) -> None:
        self.source = source
        self.missing = list(missing)
        self.duplicated = list(duplicated)
        problems = []
        if self.missing:
            problems.append("missing columns: " + ", ".join(self.missing))
        if self.duplicated:
            problems.append("duplicated columns: " + ", ".join(self.duplicated))
        super().__init__(f"{source}: " + "; ".join(problems))


class TooManyRejects(EtlError):
    """More rows were rejected than the configured ratio allows."""

    def __init__(self, source: str, *, rejected: int, read: int, max_ratio: float) -> None:
        self.source = source
        self.rejected = rejected
        self.read = read
        self.max_ratio = max_ratio
        super().__init__(
            f"{source}: {rejected} of {read} rows rejected, above the allowed ratio {max_ratio:g}"
        )


class QualityCheckFailed(EtlError):
    """At least one error-level data-quality check failed; the load was rolled back."""

    def __init__(self, failed: Sequence[str]) -> None:
        self.failed = list(failed)
        super().__init__("data-quality checks failed: " + ", ".join(self.failed))


class WatermarkConflict(EtlError):
    """The source's watermark changed while a run was loading."""

    def __init__(self, source: str) -> None:
        self.source = source
        super().__init__(f"{source}: the watermark changed during the run; nothing was loaded")


class RunLocked(EtlError):
    """Another process holds the run lock of the source."""

    def __init__(self, source: str) -> None:
        self.source = source
        super().__init__(f"{source}: another run of this source is in progress")


class SchemaNotCurrent(EtlError):
    """The database schema is not at the revision the code was written for."""

    def __init__(self, current: str | None, head: str | None) -> None:
        self.current = current
        self.head = head
        super().__init__(
            f"the database schema is at revision {current or 'none'}, the code needs"
            f" {head or 'none'}; run `etl db upgrade`"
        )


EXIT_OK = 0
EXIT_UNEXPECTED = 1

EXIT_CODES: dict[type[EtlError], int] = {
    InvalidRequest: 2,
    ConfigError: 3,
    NotFound: 4,
    SourceFormatError: 10,
    SchemaMismatch: 11,
    TooManyRejects: 12,
    QualityCheckFailed: 13,
    WatermarkConflict: 14,
    RunLocked: 15,
    SchemaNotCurrent: 16,
    EtlError: 20,
}


def exit_code_for(error: BaseException) -> int:
    """The exit code of an error: the entry of its closest class in EXIT_CODES."""
    for klass in type(error).__mro__:
        if issubclass(klass, EtlError) and klass in EXIT_CODES:
            return EXIT_CODES[klass]
    return EXIT_UNEXPECTED


def describe_error(error: BaseException) -> str:
    """Text for logs and `etl.runs.error`: never row values.

    Database errors keep only the server's primary message: their full text carries the
    statement parameters and the DETAIL line, which can hold the values of a row.
    """
    if isinstance(error, EtlError):
        return str(error)
    if isinstance(error, DBAPIError):
        diag = getattr(error.orig, "diag", None)
        primary = getattr(diag, "message_primary", None)
        if primary:
            return f"database error: {primary}"
        return f"database error: {type(error.orig).__name__}"
    return f"internal error: {type(error).__name__}"
