from __future__ import annotations

from datetime import timedelta

import pytest

from etl.api.runs import prune_runs
from etl.errors import QualityCheckFailed, TooManyRejects
from etl.infra.tables import check_results, customers, orders, rejects, runs
from etl.store.runs import RunStatus
from tests.helpers.db import count, rows
from tests.helpers.factories import (
    customer_obj,
    order_row,
    product_row,
    write_customers,
    write_orders,
    write_products,
)


def run_ids(engine):
    return [row["id"] for row in rows(engine, runs, order_by="id")]


def test_the_latest_succeeded_run_of_a_source_is_kept_even_unreferenced(
    pipeline, context, clock, tmp_path
):
    path = write_customers(tmp_path, [customer_obj()])
    pipeline.run("customers", path)  # run 1 holds the customer
    clock.advance(hours=1)
    pipeline.run("customers", path)  # run 2 writes nothing but is the latest success
    clock.advance(days=60)

    view = prune_runs(context, older_than_days=30)

    assert view.runs == 0
    assert run_ids(context.engine) == [1, 2]
    assert {row["run_id"] for row in rows(context.engine, check_results)} == {1, 2}


def test_runs_named_by_warehouse_rows_are_kept(pipeline, context, clock, tmp_path):
    pipeline.run("customers", write_customers(tmp_path, [customer_obj()]))  # 1
    clock.advance(hours=1)
    pipeline.run(
        "customers",
        write_customers(tmp_path, [customer_obj(country="fr", updated_at="2026-03-02T08:00:00Z")]),
    )  # 2: closes the version of run 1, which keeps run_id 1
    pipeline.run("products", write_products(tmp_path, [product_row()]))  # 3
    pipeline.run("orders", write_orders(tmp_path, [order_row()]))  # 4
    pipeline.run("orders", write_orders(tmp_path, [order_row(order_id="O-2")]))  # 5
    clock.advance(days=400)

    view = prune_runs(context, older_than_days=30)

    assert view.runs == 0
    assert sorted({row["run_id"] for row in rows(context.engine, customers)}) == [1, 2]
    assert sorted(row["run_id"] for row in rows(context.engine, orders)) == [4, 5]
    assert run_ids(context.engine) == [1, 2, 3, 4, 5]


def test_runs_in_progress_and_runs_at_the_cutoff_are_kept(pipeline, context, clock, tmp_path):
    for price in ("abc", "x"):  # runs 1 and 2 fail, a minute apart
        with pytest.raises(TooManyRejects):
            pipeline.run("products", write_products(tmp_path, [product_row(price=price)] * 3))
        clock.advance(minutes=1)
    clock.advance(minutes=-1)
    at_cutoff = clock.now()
    with context.engine.begin() as connection:
        connection.execute(
            runs.insert().values(
                source="orders",
                path="/exports/orders.csv",
                status=RunStatus.RUNNING,
                started_at=at_cutoff - timedelta(days=90),
            )
        )  # 3
    clock.set(at_cutoff + timedelta(days=30))

    view = prune_runs(context, older_than_days=30)

    assert view.before == at_cutoff
    assert (view.runs, view.rejects) == (1, 3)
    assert run_ids(context.engine) == [2, 3]
    assert {row["run_id"] for row in rows(context.engine, rejects)} == {2}


def test_dry_run_and_real_run_agree_and_a_second_prune_finds_nothing(
    pipeline, context, cli, clock, tmp_path
):
    pipeline.run("customers", write_customers(tmp_path, [customer_obj()]))
    for day in range(1, 5):
        pipeline.run(
            "products",
            write_products(tmp_path, [product_row(updated_at=f"2026-03-0{day}T09:00:00Z")]),
        )
        clock.advance(days=1)
    with pytest.raises(QualityCheckFailed):
        pipeline.run("orders", write_orders(tmp_path, [order_row(customer_id="nobody")]))
    clock.advance(days=10)

    dry = cli("runs", "prune", "--older-than", "7", "--dry-run")
    before = count(context.engine, runs), count(context.engine, check_results)
    real = prune_runs(context, older_than_days=7)
    again = prune_runs(context, older_than_days=7)

    assert dry.exit_code == 0, dry.output
    assert before == (6, count(context.engine, check_results) + real.check_results)
    assert dry.stdout.startswith(f"would delete {real.runs} runs")
    assert f"({real.rejects} rejects, {real.check_results} check results)" in dry.stdout
    assert real.runs == 4  # three superseded product runs and the failed orders run
    assert run_ids(context.engine) == [1, 5]
    assert again.runs == 0
