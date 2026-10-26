"""Database engine construction."""

from __future__ import annotations

import re
from typing import Any
from urllib.parse import unquote_plus, urlsplit

from sqlalchemy import Engine, create_engine, event, text

DRIVER = "postgresql+psycopg"


def to_driver_url(url: str) -> str:
    """The SQLAlchemy URL for psycopg 3 from a postgres:// or postgresql:// URL.

    This is the one place that knows the driver; the engine and Alembic both use it.
    """
    parts = urlsplit(url)
    base = parts.scheme.split("+")[0]
    if base not in {"postgres", "postgresql"}:
        raise ValueError(f"not a PostgreSQL URL: scheme {parts.scheme!r}")
    # Only the scheme changes. urlunsplit would drop the "//" of an empty authority
    # (`postgresql:///warehouse?host=/var/run/postgresql`, a Unix socket).
    return f"{DRIVER}:{url.partition(':')[2]}"


_MASK = "***"
# The user information as SQLAlchemy reads it (sqlalchemy.engine.url): a user name of anything
# but ":" and "/", "@" and "?" included, then an optional password up to the next "@".
_USER_INFORMATION = re.compile(r"([^:/]*)(?::([^@]*))?@")
# Query parameters libpq reads a secret from.
_SECRET_PARAMETERS = frozenset({"password", "sslpassword"})


def mask_url(url: str) -> str:
    """`url` with its secrets replaced, for display: the password in the user information and
    the `password` and `sslpassword` query parameters (libpq reads them all).

    It reads the URL the way SQLAlchemy does, not as urlsplit does. The user name holds
    anything but ":" and "/" ("@" and "?" included); the password starts after the ":" that
    follows it. SQLAlchemy ends the password at the next "@", this masks up to the last "@"
    before the path, query or fragment, so it may mask more than SQLAlchemy reads, never less.
    A raw "?", "#" or "/" in it is masked too. There is no fragment: the query is everything
    after the first "?" after the host, "#" included, and each secret parameter is masked up to
    its "&". Host lists (`h1:5432,h2:5433`) are left as they are.
    """
    masked, host = _mask_user_password(url)
    # A "?" in the user information does not start the query.
    question_mark = masked.find("?", host)
    if question_mark < 0:
        return masked
    query = masked[question_mark + 1 :]
    query = "&".join(_mask_parameter(item) for item in query.split("&"))
    return f"{masked[: question_mark + 1]}{query}"


def _mask_user_password(url: str) -> tuple[str, int]:
    """`url` with the password of its user information masked, and where its host starts:
    after the user information, or right after "://" when it has none."""
    scheme, slashes, rest = url.partition("://")
    if not slashes:
        return url, 0
    authority = len(scheme) + len(slashes)
    match = _USER_INFORMATION.match(rest)
    if match is None:
        return url, authority
    user, password = match.group(1, 2)
    if password is None:
        return url, authority + match.end()
    # SQLAlchemy ends the password at its first "@"; the mask runs on to the last "@" before
    # the path, query or fragment that follows, so a raw "@" in the password is masked too.
    at = match.end() - 1
    ends = [index for index in (rest.find(mark, at) for mark in "/?#") if index >= 0]
    at = rest.rfind("@", at, min(ends, default=len(rest)))
    user_information = f"{user}:{_MASK}"
    return f"{scheme}://{user_information}{rest[at:]}", authority + len(user_information) + 1


def _mask_parameter(item: str) -> str:
    """One `name=value` item of a query string, its value masked when it is a secret."""
    name, separator, _ = item.partition("=")
    if separator and unquote_plus(name) in _SECRET_PARAMETERS:
        return f"{name}={_MASK}"
    return item


def create_db_engine(url: str, *, pool_size: int = 5, echo: bool = False) -> Engine:
    engine = create_engine(
        to_driver_url(url),
        pool_size=pool_size,
        max_overflow=2,
        pool_pre_ping=True,
        echo=echo,
    )
    event.listen(engine, "connect", _use_utc)
    return engine


def _use_utc(dbapi_connection: Any, connection_record: Any) -> None:
    """Every session reads and writes timestamptz in UTC, whatever the server's or the
    client's (PGTZ) time zone: instants near the ends of the datetime range (year 1) then
    load back into Python, which an offset such as New York's would push out of range."""
    cursor = dbapi_connection.cursor()
    try:
        cursor.execute("SET TIME ZONE 'UTC'")
    finally:
        cursor.close()
    dbapi_connection.commit()


def ping(engine: Engine) -> None:
    with engine.connect() as connection:
        connection.execute(text("SELECT 1"))


def server_version(engine: Engine) -> str:
    """The PostgreSQL server version, e.g. `17.2`; fails when the database is unreachable."""
    with engine.connect() as connection:
        return str(connection.execute(text("SHOW server_version")).scalar_one())
