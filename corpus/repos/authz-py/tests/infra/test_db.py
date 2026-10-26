from __future__ import annotations

import pytest

from authz.infra.db import to_driver_url


@pytest.mark.parametrize(
    ("url", "expected"),
    [
        ("postgres://u:p@db:5432/app", "postgresql+psycopg://u:p@db:5432/app"),
        (
            "postgresql://u:p@db/app?sslmode=require",
            "postgresql+psycopg://u:p@db/app?sslmode=require",
        ),
        ("postgresql+asyncpg://u@db/app", "postgresql+psycopg://u@db/app"),
    ],
)
def test_driver_url(url, expected):
    assert to_driver_url(url) == expected


def test_driver_url_rejects_other_databases():
    with pytest.raises(ValueError, match="not a PostgreSQL URL"):
        to_driver_url("mysql://u@db/app")


async def test_ping(container):
    await container.db.ping()
