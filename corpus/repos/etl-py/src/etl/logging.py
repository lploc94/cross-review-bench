"""structlog configuration: one JSON object per line, personal data and secrets redacted.

Log events describe runs (source, run id, counts, durations), never row contents. As a second
line of defence, `redact` replaces the value of any key that names personal data or a secret,
at any depth, before the event is rendered.
"""

from __future__ import annotations

import logging
import sys
from collections.abc import Mapping
from typing import Any, TextIO

import structlog
from structlog.typing import EventDict, WrappedLogger

REDACTED = "[redacted]"

PERSONAL_KEYS = frozenset(
    {
        "email",
        "email_address",
        "full_name",
        "name",
        "first_name",
        "last_name",
        "phone",
        "phone_number",
        "mobile",
        "address",
        "street",
        "postcode",
        "zip_code",
        "date_of_birth",
    }
)

# Whole rows or their raw text: never logged, whatever they contain.
ROW_KEYS = frozenset({"row", "rows", "record", "records", "payload", "fields", "raw", "line"})

SECRET_KEYS = frozenset({"password", "secret", "token", "database_url", "authorization"})

_LEVELS = {
    "debug": logging.DEBUG,
    "info": logging.INFO,
    "warning": logging.WARNING,
    "error": logging.ERROR,
}

_MAX_DEPTH = 8


def is_sensitive(key: object) -> bool:
    if not isinstance(key, str):
        return False
    lowered = key.lower()
    return (
        lowered in PERSONAL_KEYS
        or lowered in ROW_KEYS
        or lowered in SECRET_KEYS
        or lowered.endswith(("_email", "_phone", "_password", "_secret", "_token"))
    )


def _scrub(value: Any, depth: int = 0) -> Any:
    if depth > _MAX_DEPTH:
        return REDACTED
    if isinstance(value, Mapping):
        return {
            key: REDACTED if is_sensitive(key) else _scrub(item, depth + 1)
            for key, item in value.items()
        }
    if isinstance(value, list | tuple):
        return type(value)(_scrub(item, depth + 1) for item in value)
    return value


def redact(_: WrappedLogger, __: str, event_dict: EventDict) -> EventDict:
    """Replace the value of every sensitive key, including inside nested mappings and lists."""
    for key in list(event_dict):
        if is_sensitive(key):
            event_dict[key] = REDACTED
        else:
            event_dict[key] = _scrub(event_dict[key])
    return event_dict


class _CurrentStderrHandler(logging.StreamHandler[TextIO]):
    """Writes to whatever `sys.stderr` is at the time of the call, not at configuration time,
    so output captured by a test runner or a CLI runner ends up where they expect it."""

    def __init__(self) -> None:
        super().__init__(sys.stderr)

    @property
    def stream(self) -> TextIO:
        return sys.stderr

    @stream.setter
    def stream(self, _: TextIO) -> None:
        return


def shared_processors() -> list[Any]:
    return [
        structlog.contextvars.merge_contextvars,
        structlog.stdlib.add_log_level,
        structlog.stdlib.add_logger_name,
        structlog.processors.TimeStamper(fmt="iso", utc=True),
        redact,
    ]


def configure_logging(level: str = "info", *, stream: TextIO | None = None) -> None:
    """Route structlog and the standard library (alembic, sqlalchemy) through one JSON renderer.

    Logs go to standard error so that command output on standard output stays parseable.
    """
    numeric = _LEVELS.get(level, logging.INFO)
    processors = shared_processors()
    structlog.configure(
        processors=[*processors, structlog.stdlib.ProcessorFormatter.wrap_for_formatter],
        logger_factory=structlog.stdlib.LoggerFactory(),
        wrapper_class=structlog.make_filtering_bound_logger(numeric),
        cache_logger_on_first_use=False,
    )
    formatter = structlog.stdlib.ProcessorFormatter(
        foreign_pre_chain=processors,
        processors=[
            structlog.stdlib.ProcessorFormatter.remove_processors_meta,
            structlog.processors.format_exc_info,
            structlog.processors.JSONRenderer(sort_keys=True),
        ],
    )
    handler: logging.Handler = (
        logging.StreamHandler(stream) if stream is not None else _CurrentStderrHandler()
    )
    handler.setFormatter(formatter)
    root = logging.getLogger()
    root.handlers[:] = [handler]
    root.setLevel(numeric)


def get_logger(name: str) -> structlog.stdlib.BoundLogger:
    logger: structlog.stdlib.BoundLogger = structlog.stdlib.get_logger(name)
    return logger
