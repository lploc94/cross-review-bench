"""etl_run_duration_seconds is in seconds."""

from __future__ import annotations

import io
from datetime import UTC, datetime, timedelta

from sqlalchemy import insert

from etl.infra.tables import runs
from etl.pipeline.metrics import render_metrics

START = datetime(2026, 4, 1, 8, 0, tzinfo=UTC)


def test_the_duration_of_the_latest_run_is_in_seconds(db):
    with db.begin() as connection:
        for source, seconds in (("products", 90.0), ("products", 2.5), ("customers", 0.25)):
            connection.execute(
                insert(runs).values(
                    source=source,
                    path="-",
                    status="succeeded",
                    started_at=START,
                    finished_at=START + timedelta(seconds=seconds),
                )
            )

    out = io.StringIO()
    with db.connect() as connection:
        render_metrics(connection, out)

    lines = out.getvalue().splitlines()
    assert 'etl_run_duration_seconds{source="products"} 2.5' in lines
    assert 'etl_run_duration_seconds{source="customers"} 0.25' in lines
