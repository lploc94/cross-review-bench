"""Orders and order lines through a whole run."""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from datetime import UTC, datetime
from decimal import Decimal

import pytest

from etl.errors import SourceFormatError
from etl.infra.tables import customers, order_lines, orders, runs
from etl.store import rejects, watermarks
from tests.helpers.db import rows
from tests.helpers.factories import (
    ORDER_HEADER,
    customer_obj,
    order_row,
    product_row,
    write_customers,
    write_orders,
    write_products,
)
from tests.helpers.files import write_csv


def seed_dimensions(pipeline, tmp_path, *customer_ids: str) -> None:
    ids = customer_ids or ("C-1",)
    pipeline.run(
        "customers",
        write_customers(tmp_path, [customer_obj(customer_id=cid) for cid in ids], name="c.jsonl"),
    )
    pipeline.run(
        "products",
        write_products(
            tmp_path, [product_row(sku="SKU-1"), product_row(sku="SKU-2")], name="p.csv"
        ),
    )


def lines_of(db, order_id="O-1"):
    return rows(db, order_lines, order_by="position", order_id=order_id)


def test_orders_are_loaded_with_their_lines_and_totals(pipeline, db, tmp_path):
    seed_dimensions(pipeline, tmp_path)
    path = write_orders(
        tmp_path,
        [
            order_row(position="1", sku="SKU-1", quantity="2", unit_price="12,50"),
            order_row(position="2", sku="SKU-2", quantity="1", unit_price="0,99"),
        ],
    )

    result = pipeline.run("orders", path)

    (order,) = rows(db, orders)
    (customer,) = rows(db, customers)
    assert order["total_amount"] == Decimal("25.990")
    assert order["customer_key"] == customer["customer_key"]
    assert order["ordered_at"] == datetime(2026, 3, 2, 9, 15, tzinfo=UTC)
    assert [(line["position"], line["line_amount"]) for line in lines_of(db)] == [
        (1, Decimal("25.000")),
        (2, Decimal("0.990")),
    ]
    assert all(line["product_key"] is not None for line in lines_of(db))
    assert result.counts.loaded == 1


def test_a_newer_version_replaces_the_order_and_all_its_lines(pipeline, db, tmp_path):
    seed_dimensions(pipeline, tmp_path)
    first = [order_row(position="1"), order_row(position="2", sku="SKU-2")]
    pipeline.run("orders", write_orders(tmp_path, first, name="o1.csv"))

    second = [order_row(position="1", status="shipped", updated_at="03.03.2026 08:00:00")]
    pipeline.run("orders", write_orders(tmp_path, second, name="o2.csv"))

    (order,) = rows(db, orders)
    assert order["status"] == "shipped"
    assert order["total_amount"] == Decimal("25.000")
    assert [line["position"] for line in lines_of(db)] == [1]


def test_an_older_version_leaves_the_order_and_its_lines_alone(pipeline, db, tmp_path):
    seed_dimensions(pipeline, tmp_path)
    newer = [
        order_row(position="1", status="shipped", updated_at="03.03.2026 08:00:00"),
        order_row(position="2", status="shipped", updated_at="03.03.2026 08:00:00"),
    ]
    pipeline.run("orders", write_orders(tmp_path, newer, name="new.csv"))
    with db.begin() as connection:
        watermarks.reset(connection, "orders", to=None, now=datetime.now(UTC))

    result = pipeline.run("orders", write_orders(tmp_path, [order_row()], name="old.csv"))

    assert result.counts.loaded == 0
    assert rows(db, orders)[0]["status"] == "shipped"
    assert [line["position"] for line in lines_of(db)] == [1, 2]


def test_within_a_batch_only_the_latest_version_of_an_order_counts(pipeline, db, tmp_path):
    seed_dimensions(pipeline, tmp_path)
    path = write_orders(
        tmp_path,
        [
            order_row(position="1", updated_at="02.03.2026 11:00:00", quantity="5"),
            order_row(position="1", updated_at="02.03.2026 10:30:00", quantity="1"),
            order_row(position="2", updated_at="02.03.2026 10:30:00", quantity="1"),
            # the same position twice in the latest version: the row further down wins
            order_row(position="1", updated_at="02.03.2026 11:00:00", quantity="3"),
        ],
    )

    pipeline.run("orders", path)

    (line,) = lines_of(db)
    assert line["quantity"] == 3
    assert rows(db, orders)[0]["total_amount"] == Decimal("37.500")


def test_a_version_whose_lines_disagree_is_rejected(pipeline, db, tmp_path, settings):
    seed_dimensions(pipeline, tmp_path, "C-1", "C-2")
    path = write_orders(
        tmp_path,
        [
            order_row(order_id="O-1", position="1"),
            order_row(order_id="O-1", position="2", currency="USD"),
            order_row(order_id="O-2", customer_id="C-2"),
            order_row(order_id="O-3", customer_id="C-2"),
            order_row(order_id="O-4", customer_id="C-2"),
            order_row(order_id="O-5", customer_id="C-2"),
            order_row(order_id="O-6", customer_id="C-2"),
            order_row(order_id="O-7", customer_id="C-2"),
            order_row(order_id="O-8", customer_id="C-2"),
        ],
    )

    result = pipeline.run("orders", path)

    assert sorted(row["order_id"] for row in rows(db, orders)) == [f"O-{n}" for n in range(2, 9)]
    assert result.counts.rejected == 2
    with db.connect() as connection:
        stored = rejects.for_run(connection, result.run_id)
    assert [(item.line_no, item.payload) for item in stored] == [
        (2, {"order_id": "O-1", "position": 1}),
        (3, {"order_id": "O-1", "position": 2}),
    ]


def test_a_version_with_a_rejected_line_leaves_the_stored_order_alone(pipeline, db, tmp_path):
    seed_dimensions(pipeline, tmp_path)
    first = [order_row(position="1"), order_row(position="2", sku="SKU-2")]
    pipeline.run("orders", write_orders(tmp_path, first, name="o1.csv"))

    newer = "03.03.2026 08:00:00"
    second = [
        order_row(position="1", status="shipped", updated_at=newer),
        order_row(position="2", sku="SKU-2", status="shipped", updated_at=newer, quantity="0"),
        *(order_row(order_id=f"O-{n}") for n in range(2, 9)),
    ]
    result = pipeline.run("orders", write_orders(tmp_path, second, name="o2.csv"))

    (order,) = rows(db, orders, order_id="O-1")
    assert (order["status"], order["total_amount"]) == ("paid", Decimal("50.000"))
    assert [line["position"] for line in lines_of(db)] == [1, 2]
    assert (result.counts.read, result.counts.rejected, result.counts.loaded) == (9, 2, 7)
    with db.connect() as connection:
        stored = rejects.for_run(connection, result.run_id)
    assert [(item.line_no, item.column, item.reason) for item in stored] == [
        (2, None, "another line of this order version was rejected"),
        (3, "quantity", "quantity must be between 1 and 1000000"),
    ]
    assert stored[0].payload == {"order_id": "O-1", "position": 1}


def test_a_rejected_line_only_takes_its_own_version_with_it(pipeline, db, tmp_path):
    seed_dimensions(pipeline, tmp_path)
    path = write_orders(
        tmp_path,
        [
            order_row(position="1", updated_at="02.03.2026 10:30:00"),
            order_row(position="1", status="shipped", updated_at="02.03.2026 11:00:00"),
            order_row(position="2", updated_at="02.03.2026 11:00:00", sku=""),
            *(order_row(order_id=f"O-{n}") for n in range(2, 9)),
        ],
    )

    result = pipeline.run("orders", path)

    (order,) = rows(db, orders, order_id="O-1")
    assert order["updated_at"] == datetime(2026, 3, 2, 9, 30, tzinfo=UTC)
    assert [line["position"] for line in lines_of(db)] == [1]
    assert (result.counts.rejected, result.counts.loaded) == (2, 8)


# Column order is free and undeclared columns are allowed: the reader matches names.
POSITION_FIRST = ("position", *(name for name in ORDER_HEADER if name != "position"))
UNDECLARED_FIRST = ("channel", *ORDER_HEADER)


def as_line(header: Sequence[str], row: Mapping[str, object]) -> list[object]:
    values = {"channel": "web", **row}
    return [values[name] for name in header]


def damage(values: list[object], header: Sequence[str], kind: str) -> list[object]:
    """An order line as the shop might export it by mistake."""
    damaged = list(values)
    order_id = header.index("order_id")
    if kind == "order_id and position merged":
        damaged[order_id : order_id + 2] = [f"{damaged[order_id]}{damaged[order_id + 1]}"]
    elif kind == "stray delimiter inside order_id":
        damaged[order_id : order_id + 1] = ["O", "-1"]
    elif kind == "first field dropped":
        del damaged[0]
    elif kind == "extra field at index 3":
        damaged.insert(3, "x")
    elif kind == "status left out":
        del damaged[header.index("status")]
    elif kind == "stray delimiter first":
        damaged.insert(0, "")
    elif kind == "stray delimiter in the unit price":
        damaged[-1:] = ["12", "50"]
    elif kind == "two stray delimiters":
        damaged.insert(0, "")
        damaged.insert(5, "x")
    else:  # an updated_at that is no date
        damaged[header.index("updated_at")] = "31.02.2026 11:00:00"
    return damaged


UNKNOWN_VERSION = "another line of this order was rejected and its version is unknown"
V1 = "02.03.2026 10:15:00"  # also every line's ordered_at
V2 = "02.03.2026 11:00:00"


def store_first_version(pipeline, tmp_path) -> Sequence[Mapping[str, object]]:
    seed_dimensions(pipeline, tmp_path)
    first = [
        order_row(position="1", updated_at=V1),
        order_row(position="2", sku="SKU-2", updated_at=V1),
    ]
    pipeline.run("orders", write_orders(tmp_path, first, name="o1.csv"))
    return first


def assert_first_version_kept(db) -> None:
    (order,) = rows(db, orders, order_id="O-1")
    assert (order["status"], order["total_amount"]) == ("paid", Decimal("50.000"))
    assert order["updated_at"] == datetime(2026, 3, 2, 9, 15, tzinfo=UTC)
    assert [line["position"] for line in lines_of(db)] == [1, 2]


@pytest.mark.parametrize("header", [ORDER_HEADER, POSITION_FIRST, UNDECLARED_FIRST])
def test_a_line_whose_version_is_unknown_keeps_the_whole_order_out(pipeline, db, tmp_path, header):
    first = store_first_version(pipeline, tmp_path)

    damaged_row = order_row(position="2", status="shipped", updated_at=V2)
    second = [
        *(as_line(header, row) for row in first),
        as_line(header, order_row(position="1", status="shipped", updated_at=V2)),
        damage(as_line(header, damaged_row), header, "unreadable updated_at"),
        *(as_line(header, order_row(order_id=f"O-{n}")) for n in range(2, 16)),
    ]
    path = write_csv(tmp_path / "o2.csv", header, second, delimiter=";")
    result = pipeline.run("orders", path)

    assert_first_version_kept(db)
    assert (result.counts.read, result.counts.rejected, result.counts.loaded) == (18, 4, 14)
    assert len(rows(db, orders)) == 15
    with db.connect() as connection:
        stored = rejects.for_run(connection, result.run_id)
    assert [(item.line_no, item.reason) for item in stored] == [
        (2, UNKNOWN_VERSION),
        (3, UNKNOWN_VERSION),
        (4, UNKNOWN_VERSION),
        (5, "updated_at does not match %d.%m.%Y %H:%M:%S or %d.%m.%Y %H:%M"),
    ]


@pytest.mark.parametrize(
    ("header", "kind"),
    [
        (ORDER_HEADER, "order_id and position merged"),  # O-1;2 read as O-12
        (ORDER_HEADER, "stray delimiter inside order_id"),  # O;-1
        (ORDER_HEADER, "first field dropped"),
        (ORDER_HEADER, "extra field at index 3"),
        (ORDER_HEADER, "status left out"),
        (ORDER_HEADER, "stray delimiter first"),
        (ORDER_HEADER, "stray delimiter in the unit price"),
        (ORDER_HEADER, "two stray delimiters"),
        (POSITION_FIRST, "status left out"),
        (UNDECLARED_FIRST, "stray delimiter first"),
    ],
)
def test_an_order_line_that_cannot_be_split_fails_the_run(pipeline, db, tmp_path, header, kind):
    store_first_version(pipeline, tmp_path)

    damaged_row = order_row(position="2", status="shipped", updated_at=V2)
    second = [
        as_line(header, order_row(position="1", status="shipped", updated_at=V2)),
        damage(as_line(header, damaged_row), header, kind),
        *(as_line(header, order_row(order_id=f"O-{n}")) for n in range(2, 16)),
    ]
    path = write_csv(tmp_path / "o2.csv", header, second, delimiter=";")

    with pytest.raises(SourceFormatError) as caught:
        pipeline.run("orders", path)

    assert str(caught.value) == "line 3: an order line could not be split into its fields"
    assert_first_version_kept(db)
    assert len(rows(db, orders)) == 1
    (run,) = rows(db, runs, id=caught.value.run_id)
    assert run["status"] == "failed"
    with db.connect() as connection:
        (stored,) = rejects.for_run(connection, run["id"])
    assert stored.line_no == 3
    assert stored.reason.startswith(f"expected {len(header)} fields, found ")


@pytest.mark.parametrize(
    ("order_id", "reason"),
    [
        ("", "order_id is missing"),
        ("O-" + "1" * 63, "order_id is longer than 64 characters"),
        ("O-\x001", "order_id contains a NUL character"),
    ],
)
def test_an_order_line_without_a_readable_order_id_fails_the_run(
    pipeline, db, tmp_path, order_id, reason
):
    store_first_version(pipeline, tmp_path)

    second = [
        order_row(position="1", status="shipped", updated_at=V2),
        order_row(order_id=order_id, position="2", status="shipped", updated_at=V2),
        *(order_row(order_id=f"O-{n}") for n in range(2, 16)),
    ]

    with pytest.raises(SourceFormatError) as caught:
        pipeline.run("orders", write_orders(tmp_path, second, name="o2.csv"))

    assert str(caught.value) == "line 3: an order line has no readable order_id"
    assert_first_version_kept(db)
    assert len(rows(db, orders)) == 1
    (run,) = rows(db, runs, id=caught.value.run_id)
    assert run["status"] == "failed"
    with db.connect() as connection:
        (stored,) = rejects.for_run(connection, run["id"])
    assert (stored.line_no, stored.column, stored.reason) == (3, "order_id", reason)


def test_yen_orders_keep_whole_amounts(pipeline, db, tmp_path):
    seed_dimensions(pipeline, tmp_path)
    path = write_orders(tmp_path, [order_row(currency="JPY", unit_price="1.200", quantity="3")])

    pipeline.run("orders", path)

    assert rows(db, orders)[0]["total_amount"] == Decimal("3600.000")
