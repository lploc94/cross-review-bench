from __future__ import annotations

import json

from etl.errors import EXIT_CODES, QualityCheckFailed, RunLocked, SchemaMismatch, TooManyRejects
from tests.helpers.db import HeldLock
from tests.helpers.factories import (
    customer_obj,
    order_row,
    product_row,
    write_customers,
    write_orders,
    write_products,
)
from tests.helpers.files import write_text


def test_run_prints_the_finished_run(cli, tmp_path):
    path = write_products(tmp_path, [product_row(sku="A"), product_row(sku="B")])

    result = cli("run", "products", path)

    assert result.exit_code == 0, result.output
    assert "run 1: products succeeded" in result.stdout
    assert "loaded    2" in result.stdout


def test_run_json_output_is_the_run_record(cli, tmp_path):
    path = write_customers(tmp_path, [customer_obj()])

    result = cli("run", "customers", path, "--json")

    assert result.exit_code == 0, result.output
    run = json.loads(result.stdout)
    assert run["status"] == "succeeded"
    assert (run["rows_read"], run["rows_loaded"], run["rows_rejected"]) == (1, 1, 0)
    assert run["path"] == str(path)


def test_an_unknown_source_or_file_exits_with_not_found(cli, tmp_path):
    unknown = cli("run", "invoices", tmp_path / "x.csv")
    missing = cli("run", "orders", tmp_path / "missing.csv")

    assert unknown.exit_code == missing.exit_code == 4
    assert "unknown source 'invoices'" in unknown.stderr
    assert "does not exist" in missing.stderr


def test_a_schema_mismatch_exits_with_its_code_and_names_the_run(cli, tmp_path):
    path = write_text(tmp_path / "orders.csv", "order_id;position\nO-1;1\n")

    result = cli("run", "orders", path)

    assert result.exit_code == EXIT_CODES[SchemaMismatch] == 11
    assert "missing columns: customer_id" in result.stderr
    assert "see: etl runs show 1" in result.stderr


def test_failed_quality_checks_and_too_many_rejects_have_their_own_codes(cli, tmp_path):
    orphan = write_orders(tmp_path, [order_row(customer_id="nobody")])
    rejects = write_customers(tmp_path, [customer_obj(email="x")])

    assert cli("run", "orders", orphan).exit_code == EXIT_CODES[QualityCheckFailed]
    assert cli("run", "customers", rejects).exit_code == EXIT_CODES[TooManyRejects]


def test_a_locked_source_exits_with_run_locked(cli, db, tmp_path):
    path = write_products(tmp_path, [product_row()])

    with HeldLock(db, "products"):
        result = cli("run", "products", path)

    assert result.exit_code == EXIT_CODES[RunLocked] == 15
    assert "another run of this source is in progress" in result.stderr


def test_logs_go_to_stderr_without_personal_data(cli, tmp_path):
    path = write_customers(
        tmp_path,
        [customer_obj(customer_id=f"C-{n}", email=f"ada{n}@example.com") for n in range(4)]
        + [customer_obj(customer_id="C-9", email="bad")],
    )

    result = cli("run", "customers", path, "--json")

    assert json.loads(result.stdout)["rows_rejected"] == 1
    assert result.stderr.count('"event": "run.succeeded"') == 1
    assert "example.com" not in result.stderr
    assert "Ada Example" not in result.stderr
