"""Quality checks after a load: error-level failures roll back, warn-level ones are recorded."""

from __future__ import annotations

import pytest

from etl.errors import QualityCheckFailed
from etl.infra.tables import check_results, order_lines, orders, runs
from etl.store import watermarks
from tests.helpers.db import count, rows
from tests.helpers.factories import (
    customer_obj,
    order_row,
    product_row,
    write_customers,
    write_orders,
    write_products,
)


def results_by_name(db, run_id):
    return {row["check_name"]: row for row in rows(db, check_results, run_id=run_id)}


def test_an_order_for_an_unknown_customer_fails_and_rolls_back_the_load(pipeline, db, tmp_path):
    pipeline.run("customers", write_customers(tmp_path, [customer_obj(customer_id="C-1")]))
    path = write_orders(
        tmp_path, [order_row(order_id="O-1"), order_row(order_id="O-2", customer_id="C-404")]
    )

    with pytest.raises(QualityCheckFailed) as caught:
        pipeline.run("orders", path)

    assert caught.value.failed == ["orders.customer_id.references_customers"]
    assert count(db, orders) == 0
    assert count(db, order_lines) == 0
    with db.connect() as connection:
        assert watermarks.read(connection, "orders") is None
    run = rows(db, runs, id=caught.value.run_id)[0]
    assert run["status"] == "failed"
    assert run["rows_loaded"] == 0
    assert "orders.customer_id.references_customers" in run["error"]
    failed = results_by_name(db, run["id"])["orders.customer_id.references_customers"]
    assert (failed["passed"], failed["severity"], failed["observed"]) == (False, "error", 1)
    assert failed["details"] == "1 row whose customer_id is missing from customers"


def test_a_warn_level_failure_is_recorded_and_the_run_succeeds(pipeline, db, tmp_path):
    pipeline.run("customers", write_customers(tmp_path, [customer_obj()]))
    pipeline.run("products", write_products(tmp_path, [product_row(sku="SKU-1")]))
    path = write_orders(tmp_path, [order_row(sku="SKU-1"), order_row(position="2", sku="NEW")])

    result = pipeline.run("orders", path)

    warned = results_by_name(db, result.run_id)["order_lines.product_id.references_products"]
    assert (warned["passed"], warned["severity"]) == (False, "warn")
    assert count(db, order_lines) == 2
    assert rows(db, order_lines, position=2)[0]["product_key"] is None
    assert [c.check_name for c in result.checks if not c.passed] == [
        "order_lines.product_id.references_products"
    ]


def test_only_the_checks_of_the_loaded_tables_run(pipeline, db, tmp_path):
    result = pipeline.run("products", write_products(tmp_path, [product_row()]))

    assert sorted(results_by_name(db, result.run_id)) == [
        "products.currency.accepted_values",
        "products.name.not_null",
        "products.product_id.unique",
        "products.row_count_delta",
    ]
    assert all(row["passed"] for row in rows(db, check_results))


def test_row_count_delta_compares_with_the_previous_successful_run(pipeline, db, tmp_path):
    first = [customer_obj(customer_id=f"C-{n}") for n in range(2)]
    pipeline.run("customers", write_customers(tmp_path, first, name="a.jsonl"))

    more = [customer_obj(customer_id=f"N-{n}") for n in range(4)]
    result = pipeline.run("customers", write_customers(tmp_path, more, name="b.jsonl"))

    delta = results_by_name(db, result.run_id)["customers.row_count_delta"]
    assert delta["passed"] is False
    assert delta["observed"] == 6
    assert delta["details"] == "6 rows, 200.0% change from 2"


def test_a_failed_run_is_no_baseline_for_the_row_count_delta(pipeline, db, tmp_path):
    pipeline.run("customers", write_customers(tmp_path, [customer_obj()], name="a.jsonl"))
    bad = [customer_obj(customer_id=f"B-{n}", email="x") for n in range(3)]
    with pytest.raises(Exception, match="rejected"):
        pipeline.run("customers", write_customers(tmp_path, bad, name="b.jsonl"))

    result = pipeline.run(
        "customers", write_customers(tmp_path, [customer_obj(customer_id="C-2")], name="c.jsonl")
    )

    delta = results_by_name(db, result.run_id)["customers.row_count_delta"]
    assert delta["details"] == "2 rows, 100.0% change from 1"
