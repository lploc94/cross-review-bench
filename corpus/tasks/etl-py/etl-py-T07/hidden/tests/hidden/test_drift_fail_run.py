"""Under the `fail` drift policy the run fails: the error reaches the caller and the CLI."""

from __future__ import annotations

import pytest

from etl.errors import SchemaDrift, exit_code_for
from etl.infra.tables import products, runs, schema_drift
from tests.helpers.db import count, rows
from tests.helpers.factories import PRODUCT_HEADER, product_row
from tests.helpers.files import write_csv


def drifting_products(tmp_path):
    return write_csv(
        tmp_path / "products.csv",
        (*PRODUCT_HEADER, "colour"),
        [{**product_row(), "colour": "blue"}],
        delimiter=",",
    )


def without_a_declared_optional_column(tmp_path):
    header = tuple(column for column in PRODUCT_HEADER if column != "active")
    row = {key: value for key, value in product_row().items() if key != "active"}
    return write_csv(tmp_path / "products.csv", header, [row], delimiter=",")


def test_the_pipeline_raises_schema_drift_and_records_the_failed_run(pipeline, db, tmp_path):
    with pytest.raises(SchemaDrift) as caught:
        pipeline.run("products", drifting_products(tmp_path))

    (run,) = rows(db, runs)
    assert caught.value.run_id == run["id"]
    assert run["status"] == "failed"
    assert count(db, products) == 0
    assert [(row["column_name"], row["kind"]) for row in rows(db, schema_drift)] == [
        ("colour", "undeclared")
    ]


def test_the_command_fails_with_the_drift_exit_code(cli, db, tmp_path):
    result = cli("run", "products", drifting_products(tmp_path))

    assert result.exit_code != 0
    assert result.exit_code == exit_code_for(SchemaDrift("products", undeclared=["colour"]))
    assert "undeclared columns: colour" in result.stderr
    assert "see: etl runs show 1" in result.stderr


def test_a_missing_optional_column_fails_the_run_too(pipeline, db, tmp_path):
    with pytest.raises(SchemaDrift) as caught:
        pipeline.run("products", without_a_declared_optional_column(tmp_path))

    (run,) = rows(db, runs)
    assert caught.value.run_id == run["id"]
    assert run["status"] == "failed"
    assert count(db, products) == 0
    assert [(row["column_name"], row["kind"]) for row in rows(db, schema_drift)] == [
        ("active", "missing")
    ]


def test_the_command_fails_when_an_optional_column_is_missing(cli, db, tmp_path):
    result = cli("run", "products", without_a_declared_optional_column(tmp_path))

    assert result.exit_code != 0
    assert result.exit_code == exit_code_for(SchemaDrift("products", missing=["active"]))
    assert "missing columns: active" in result.stderr
