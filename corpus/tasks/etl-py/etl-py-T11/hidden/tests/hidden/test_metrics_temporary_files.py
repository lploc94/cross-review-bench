"""A metrics write that fails leaves the collector directory as it was."""

from __future__ import annotations

from pathlib import Path

import pytest

from etl.pipeline import metrics
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


def test_a_failed_rendering_leaves_no_files_behind(
    metered, metrics_file, clock, tmp_path, monkeypatch
):
    metered.run("products", write_products(tmp_path, [product_row(sku="A")], name="a.csv"))
    before = metrics_file.read_text(encoding="utf-8")

    def failing(connection, out):
        out.write("# HELP etl_runs_total Finished runs per source and status.\n")
        raise RuntimeError("the database went away")

    monkeypatch.setattr(metrics, "render_metrics", failing)
    for n in range(3):
        clock.advance(hours=1)
        rows = [product_row(sku=f"B-{n}", updated_at=f"2026-03-0{n + 2}T09:00:00Z")]
        result = metered.run("products", write_products(tmp_path, rows, name=f"b{n}.csv"))
        assert result.counts.loaded == 1

    assert sorted(path.name for path in metrics_file.parent.iterdir()) == ["etl.prom"]
    assert metrics_file.read_text(encoding="utf-8") == before
