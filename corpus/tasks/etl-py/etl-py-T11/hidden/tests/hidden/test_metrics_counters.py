"""etl_*_total are Prometheus counters: they add up every finished run and never go down."""

from __future__ import annotations

from datetime import UTC, datetime
from pathlib import Path

import pytest
from sqlalchemy import insert

from etl.infra.tables import runs
from etl.pipeline.runner import Pipeline
from tests.helpers.factories import product_row, write_products


@pytest.fixture
def metrics_file(tmp_path: Path) -> Path:
    directory = tmp_path / "textfile"
    directory.mkdir()
    return directory / "etl.prom"


@pytest.fixture
def metered(db, settings, clock, metrics_file) -> Pipeline:
    return Pipeline(db, settings.model_copy(update={"metrics_file": metrics_file}), clock)


def samples(path: Path) -> dict[str, float]:
    values = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        if line and not line.startswith("#"):
            name, value = line.rsplit(" ", 1)
            values[name] = float(value)
    return values


def loaded(values: dict[str, float]) -> float:
    return values['etl_rows_total{source="products",kind="loaded"}']


def test_two_runs_add_up(metered, metrics_file, clock, tmp_path):
    first = [product_row(sku=f"A-{n}") for n in range(3)]
    metered.run("products", write_products(tmp_path, first, name="a.csv"))
    after_first = samples(metrics_file)

    clock.advance(hours=1)
    second = [product_row(sku=f"B-{n}", updated_at="2026-03-02T09:00:00Z") for n in range(2)]
    metered.run("products", write_products(tmp_path, second, name="b.csv"))
    after_second = samples(metrics_file)

    assert loaded(after_first) == 3
    assert loaded(after_second) == 5
    assert after_second['etl_rows_total{source="products",kind="read"}'] == 5
    assert after_second['etl_runs_total{source="products",status="succeeded"}'] == 2


def test_runs_recorded_by_earlier_processes_are_counted(db, metered, metrics_file, tmp_path):
    with db.begin() as connection:
        connection.execute(
            insert(runs).values(
                source="products",
                path="/exports/products-old.csv",
                status="succeeded",
                started_at=datetime(2026, 3, 30, 8, 0, tzinfo=UTC),
                finished_at=datetime(2026, 3, 30, 8, 1, tzinfo=UTC),
                rows_read=7,
                rows_loaded=6,
                rows_rejected=1,
            )
        )

    metered.run("products", write_products(tmp_path, [product_row()]))

    values = samples(metrics_file)
    assert loaded(values) == 7
    assert values['etl_rows_total{source="products",kind="rejected"}'] == 1
    assert values['etl_runs_total{source="products",status="succeeded"}'] == 2
