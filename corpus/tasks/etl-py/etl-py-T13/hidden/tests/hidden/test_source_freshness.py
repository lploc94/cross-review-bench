from __future__ import annotations

import json
from datetime import timedelta

import pytest

from etl.api.sources import source_freshness
from etl.errors import EXIT_CODES, SourcesStale, TooManyRejects, exit_code_for
from etl.infra.tables import runs
from tests.helpers.factories import (
    customer_obj,
    order_row,
    product_row,
    write_customers,
    write_orders,
    write_products,
)


def load_everything(pipeline, tmp_path):
    pipeline.run("customers", write_customers(tmp_path, [customer_obj()]))
    pipeline.run("products", write_products(tmp_path, [product_row()]))
    pipeline.run("orders", write_orders(tmp_path, [order_row()]))


def by_source(context):
    return {view.source: view for view in source_freshness(context)}


def test_exactly_the_max_age_is_still_fresh(pipeline, context, cli, clock, tmp_path):
    load_everything(pipeline, tmp_path)
    clock.advance(hours=2)

    at_limit = cli("sources", "stale")
    views = by_source(context)
    clock.advance(seconds=1)
    past_limit = cli("sources", "stale", "--json")

    assert at_limit.exit_code == 0, at_limit.output
    assert views["orders"].age == timedelta(hours=2)
    assert not views["orders"].stale
    assert past_limit.exit_code == 17
    stale = {view["source"] for view in json.loads(past_limit.stdout) if view["stale"]}
    assert stale == {"orders"}


def test_a_failed_or_running_run_does_not_make_a_source_fresh(pipeline, context, clock, tmp_path):
    pipeline.run("products", write_products(tmp_path, [product_row()]))
    first_success = clock.now()
    clock.advance(days=8)
    with pytest.raises(TooManyRejects):
        pipeline.run("products", write_products(tmp_path, [product_row(price="abc")] * 3))
    with context.engine.begin() as connection:
        connection.execute(
            runs.insert().values(
                source="products", path="/x.csv", status="running", started_at=clock.now()
            )
        )

    view = by_source(context)["products"]

    assert view.stale
    assert view.last_succeeded_run_id == 1
    assert view.last_succeeded_at == first_success
    assert view.age == timedelta(days=8)


def test_never_loaded_sources_are_stale_without_an_age(context, db):
    views = by_source(context)

    assert all(view.stale and view.age is None for view in views.values())
    assert all(view.last_succeeded_at is None for view in views.values())


def test_the_stale_exit_code_is_not_shared(cli, db):
    code = exit_code_for(SourcesStale(["orders"]))
    others = {value for klass, value in EXIT_CODES.items() if klass is not SourcesStale}

    result = cli("sources", "stale")

    assert code == 17
    assert code not in others
    assert result.exit_code == 17
    assert "orders" in result.stderr
