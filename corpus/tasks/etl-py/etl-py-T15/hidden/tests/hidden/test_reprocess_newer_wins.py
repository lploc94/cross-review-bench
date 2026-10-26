from __future__ import annotations

from datetime import UTC, datetime

from etl.domain import contact, money
from etl.infra.tables import customers, products, watermarks
from tests.helpers.db import count, rows
from tests.helpers.factories import customer_obj, product_row, write_customers, write_products

OLD = "2026-03-20T09:00:00Z"
LATER = "2026-03-25T09:00:00Z"


def test_a_reprocessed_product_never_replaces_a_newer_one(
    pipeline, db, clock, monkeypatch, tmp_path
):
    good = [product_row(sku=f"G-{n}") for n in range(6)]
    first = pipeline.run(
        "products",
        write_products(
            tmp_path,
            [
                *good,
                product_row(
                    sku="SKU-A", name="Old name", price="1.00", currency="RSD", updated_at=OLD
                ),
                product_row(
                    sku="SKU-B", name="Brand new", price="2.00", currency="RSD", updated_at=OLD
                ),
            ],
            name="first.csv",
        ),
    )
    clock.set(datetime(2026, 4, 1, 20, 0, tzinfo=UTC))
    second = pipeline.run(
        "products",
        write_products(
            tmp_path,
            [product_row(sku="SKU-A", name="New name", price="3.00", updated_at=LATER)],
            name="second.csv",
        ),
    )
    mark_before = rows(db, watermarks)
    monkeypatch.setitem(money.CURRENCIES, "RSD", money.Currency("RSD", 2))

    result = pipeline.reprocess(first.run_id)

    stored = {row["product_id"]: row for row in rows(db, products)}
    assert (stored["SKU-A"]["name"], str(stored["SKU-A"]["list_price"])) == ("New name", "3.000")
    assert stored["SKU-A"]["run_id"] == second.run_id
    assert stored["SKU-A"]["updated_at"] == datetime(2026, 3, 25, 9, 0, tzinfo=UTC)
    assert (stored["SKU-B"]["name"], stored["SKU-B"]["run_id"]) == ("Brand new", result.run_id)
    assert (result.counts.read, result.counts.skipped, result.counts.loaded) == (2, 0, 1)
    assert rows(db, watermarks) == mark_before


def test_a_reprocessed_customer_never_replaces_a_newer_version(
    pipeline, db, clock, monkeypatch, tmp_path
):
    good = [customer_obj(customer_id=f"G-{n}") for n in range(6)]
    national = {"country": "hu", "phone": "1 234 5678"}
    first = pipeline.run(
        "customers",
        write_customers(
            tmp_path,
            [
                *good,
                customer_obj(
                    customer_id="C-9", email="old@example.com", updated_at=OLD, **national
                ),
                customer_obj(
                    customer_id="C-8", email="first@example.com", updated_at=OLD, **national
                ),
            ],
            name="first.jsonl",
        ),
    )
    clock.set(datetime(2026, 4, 1, 20, 0, tzinfo=UTC))
    pipeline.run(
        "customers",
        write_customers(
            tmp_path,
            [customer_obj(customer_id="C-9", email="new@example.com", updated_at=LATER)],
            name="second.jsonl",
        ),
    )
    monkeypatch.setitem(contact.CALLING_CODES, "HU", "36")

    result = pipeline.reprocess(first.run_id)
    again = pipeline.reprocess(first.run_id)

    (c9,) = rows(db, customers, customer_id="C-9")
    assert (c9["email"], c9["is_current"], c9["valid_to"]) == ("new@example.com", True, None)
    (c8,) = rows(db, customers, customer_id="C-8")
    assert (c8["email"], c8["phone"], c8["is_current"], c8["run_id"]) == (
        "first@example.com",
        "+3612345678",
        True,
        result.run_id,
    )
    assert result.counts.loaded == 1
    assert again.counts.loaded == 0
    assert count(db, customers) == 8
