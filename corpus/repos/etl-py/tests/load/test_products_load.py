"""Products through a whole run: newer-wins upsert and deduplication within a batch."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from decimal import Decimal

from etl.infra.tables import products, rejects
from etl.store import watermarks
from tests.helpers.db import count, rows
from tests.helpers.factories import PRODUCT_HEADER, product_row, write_products


def test_a_first_run_inserts_every_product(pipeline, db, tmp_path):
    path = write_products(tmp_path, [product_row(sku="A"), product_row(sku="B", price="3")])

    result = pipeline.run("products", path)

    assert (result.counts.read, result.counts.loaded, result.counts.rejected) == (2, 2, 0)
    stored = rows(db, products, order_by="product_id")
    assert [(row["product_id"], row["list_price"]) for row in stored] == [
        ("A", Decimal("12.500")),
        ("B", Decimal("3.000")),
    ]
    assert {row["run_id"] for row in stored} == {result.run_id}


def test_loading_the_same_file_twice_writes_nothing_the_second_time(pipeline, db, tmp_path):
    path = write_products(tmp_path, [product_row(sku="A"), product_row(sku="B")])
    pipeline.run("products", path)

    with db.begin() as connection:  # re-read everything, as after a watermark reset
        watermarks.reset(connection, "products", to=None, now=datetime.now(UTC))
    again = pipeline.run("products", path)

    assert again.counts.read == 2
    assert again.counts.loaded == 0
    assert count(db, products) == 2


def test_a_newer_row_updates_the_product(pipeline, db, tmp_path):
    pipeline.run("products", write_products(tmp_path, [product_row(price="10.00")], name="a.csv"))

    newer = product_row(price="11.00", updated_at="2026-03-02T09:00:00Z")
    result = pipeline.run("products", write_products(tmp_path, [newer], name="b.csv"))

    assert result.counts.loaded == 1
    (stored,) = rows(db, products)
    assert stored["list_price"] == Decimal("11.000")
    assert stored["run_id"] == result.run_id


def test_an_older_row_never_overwrites_a_newer_one(pipeline, db, tmp_path):
    newer = product_row(price="11.00", updated_at="2026-03-02T09:00:00Z")
    pipeline.run("products", write_products(tmp_path, [newer], name="new.csv"))
    with db.begin() as connection:
        watermarks.reset(connection, "products", to=None, now=datetime.now(UTC))

    older = product_row(price="10.00", updated_at="2026-03-02T08:59:59Z")
    result = pipeline.run("products", write_products(tmp_path, [older], name="old.csv"))

    assert result.counts.loaded == 0
    (stored,) = rows(db, products)
    assert stored["list_price"] == Decimal("11.000")
    assert stored["updated_at"] == datetime(2026, 3, 2, 9, 0, tzinfo=UTC)


def test_within_a_batch_the_latest_update_wins_whatever_the_file_order(pipeline, db, tmp_path):
    path = write_products(
        tmp_path,
        [
            product_row(sku="A", price="3.00", updated_at="2026-03-03T00:00:00Z"),
            product_row(sku="A", price="1.00", updated_at="2026-03-01T00:00:00Z"),
            product_row(sku="A", price="2.00", updated_at="2026-03-02T00:00:00Z"),
        ],
    )

    result = pipeline.run("products", path)

    assert result.counts.loaded == 1
    (stored,) = rows(db, products)
    assert stored["list_price"] == Decimal("3.000")


def test_within_a_batch_a_tie_goes_to_the_row_further_down(pipeline, db, tmp_path):
    same_time = "2026-03-03T00:00:00Z"
    path = write_products(
        tmp_path,
        [
            product_row(sku="A", name="first", updated_at=same_time),
            product_row(sku="A", name="second", updated_at=same_time),
            product_row(sku="A", name="third", updated_at=same_time),
        ],
    )

    pipeline.run("products", path)

    (stored,) = rows(db, products)
    assert stored["name"] == "third"


def test_a_row_stamped_slightly_ahead_does_not_hide_rows_exported_after_it(
    pipeline, db, tmp_path, clock
):
    now = clock.now()
    ahead = product_row(sku="A", updated_at=(now + timedelta(minutes=4)).isoformat())
    pipeline.run("products", write_products(tmp_path, [ahead], name="a.csv"))

    clock.advance(minutes=10)
    later = [
        product_row(sku="B", updated_at=(now + timedelta(minutes=1)).isoformat()),
        product_row(sku="C", updated_at=(now + timedelta(minutes=4)).isoformat()),
    ]
    result = pipeline.run("products", write_products(tmp_path, later, name="b.csv"))

    assert (result.counts.skipped, result.counts.loaded) == (0, 2)
    assert [row["product_id"] for row in rows(db, products, order_by="product_id")] == [
        "A",
        "B",
        "C",
    ]


def test_a_product_line_that_cannot_be_split_is_a_single_reject(pipeline, db, tmp_path):
    good = [product_row(sku=f"P-{n}") for n in range(4)]
    stray = [*(product_row(sku="P-9").values()), "extra"]
    path = write_products(tmp_path, [*good[:2], stray, *good[2:]])

    result = pipeline.run("products", path)

    assert (result.counts.read, result.counts.rejected, result.counts.loaded) == (5, 1, 4)
    (stored,) = rows(db, rejects)
    assert (stored["line_no"], stored["reason"]) == (
        4,
        f"expected {len(PRODUCT_HEADER)} fields, found 8",
    )
