from __future__ import annotations

import pytest
from sqlalchemy import make_url

from etl.infra.db import mask_url, to_driver_url


@pytest.mark.parametrize(
    ("url", "masked"),
    [
        ("postgres://etl:s3cret@db:5432/warehouse", "postgres://etl:***@db:5432/warehouse"),
        (
            "postgresql://etl:p%40ss@db/warehouse?sslmode=require",
            "postgresql://etl:***@db/warehouse?sslmode=require",
        ),
        ("postgres://etl@db/warehouse", "postgres://etl@db/warehouse"),
        ("postgres://etl:pw@[::1]:5432/warehouse", "postgres://etl:***@[::1]:5432/warehouse"),
        (
            "postgresql://etl@db/warehouse?password=s3cret",
            "postgresql://etl@db/warehouse?password=***",
        ),
        (
            "postgresql://etl@db/warehouse?sslmode=require&password=p%40ss&application_name=etl",
            "postgresql://etl@db/warehouse?sslmode=require&password=***&application_name=etl",
        ),
        (
            "postgresql:///warehouse?host=/var/run/postgresql&password=s3cret",
            "postgresql:///warehouse?host=/var/run/postgresql&password=***",
        ),
        (
            "postgresql://etl@db/warehouse?sslpassword=k3y#top",
            "postgresql://etl@db/warehouse?sslpassword=***",
        ),
        # the password is read up to the "@", "?" and "#" included
        ("postgres://etl:p?ss@db/w", "postgres://etl:***@db/w"),
        ("postgres://etl:p#ss@db/w?password=x", "postgres://etl:***@db/w?password=***"),
        ("postgres://etl:p@ss@db/w", "postgres://etl:***@db/w"),
        ("postgres://u:pw@h1:5432,h2:5433/w", "postgres://u:***@h1:5432,h2:5433/w"),
        ("postgres://h1:5432,h2:5433/w?password=pw", "postgres://h1:5432,h2:5433/w?password=***"),
        (
            "postgres://etl:pw@db?application_name=a@b",
            "postgres://etl:***@db?application_name=a@b",
        ),
        (
            "postgres://etl:pw@db/warehouse?password=pw2",
            "postgres://etl:***@db/warehouse?password=***",
        ),
    ],
)
def test_passwords_are_masked(url, masked):
    assert mask_url(url) == masked


@pytest.mark.parametrize("scheme", ["postgres", "postgresql", "postgresql+psycopg2"])
def test_every_postgres_scheme_gets_the_psycopg_driver(scheme):
    assert to_driver_url(f"{scheme}://u:p@h:5432/d") == "postgresql+psycopg://u:p@h:5432/d"


def test_other_schemes_are_refused():
    with pytest.raises(ValueError, match="not a PostgreSQL URL"):
        to_driver_url("mysql://u:p@h/d")


def test_a_url_without_a_host_keeps_its_empty_authority():
    driver_url = to_driver_url("postgresql:///warehouse?host=/var/run/postgresql")

    assert driver_url == "postgresql+psycopg:///warehouse?host=/var/run/postgresql"
    parsed = make_url(driver_url)
    assert (parsed.host, parsed.database) == (None, "warehouse")
    assert parsed.query == {"host": "/var/run/postgresql"}


# SQLAlchemy has no fragment: its query is everything after the first "?", "#" included.
@pytest.mark.parametrize(
    ("url", "masked"),
    [
        ("postgres://etl@db/w?x=1&password=a#b", "postgres://etl@db/w?x=1&password=***"),
        ("postgres://etl@db/w?password=s3cret#frag", "postgres://etl@db/w?password=***"),
        ("postgres://etl@db/w?x=1#&password=s3cret", "postgres://etl@db/w?x=1#&password=***"),
        ("postgres://etl@db/w#?password=s3cret", "postgres://etl@db/w#?password=***"),
        ("postgres://etl:p#ss@db/w?sslpassword=k#ey", "postgres://etl:***@db/w?sslpassword=***"),
        # a raw "?" in the user name is no query
        ("postgres://us?er:pw@db/w?password=q2", "postgres://us?er:***@db/w?password=***"),
        ("postgres://us?er@db/w?password=q2", "postgres://us?er@db/w?password=***"),
        # SQLAlchemy's user name holds anything but ":" and "/", "@" included
        ("postgres://u@x?y@db/w?password=SEKq", "postgres://u@x?y@db/w?password=***"),
        ("postgres://u@x?y:pw@db/w?password=SEKq", "postgres://u@x?y:***@db/w?password=***"),
    ],
)
def test_no_part_of_a_secret_the_driver_reads_is_shown(url, masked):
    parsed = make_url(to_driver_url(url))
    secrets = [parsed.password, parsed.query.get("password"), parsed.query.get("sslpassword")]
    used = [secret for secret in secrets if isinstance(secret, str) and secret]
    assert used

    assert mask_url(url) == masked
    assert not any(secret in masked for secret in used)
