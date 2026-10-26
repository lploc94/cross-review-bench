"""A placeholder customer created by an orders run must give way to the CRM row, whatever the
CRM row's change time: the CRM changed the customer before the order run saw the order."""

from __future__ import annotations

from datetime import UTC, datetime

from etl.infra.tables import customers, orders
from tests.helpers.db import rows
from tests.helpers.factories import customer_obj, order_row, write_customers, write_orders


def current_version(db, customer_id):
    (current,) = rows(db, customers, customer_id=customer_id, is_current=True)
    return current


def test_a_crm_row_changed_before_the_order_run_replaces_the_placeholder(
    pipeline, db, clock, tmp_path
):
    # The orders run at 2026-04-01 08:00 UTC meets C-7 for the first time.
    pipeline.run("orders", write_orders(tmp_path, [order_row(customer_id="C-7")]))
    assert current_version(db, "C-7")["is_placeholder"] is True

    clock.advance(hours=2)
    # The CRM created C-7 on March 1st, before the order (March 2nd) and the order run.
    crm = customer_obj(customer_id="C-7", updated_at="2026-03-01T08:00:00Z")
    pipeline.run("customers", write_customers(tmp_path, [crm]))

    current = current_version(db, "C-7")
    assert current["is_placeholder"] is False
    assert current["email"] == "ada.example@example.com"
    assert current["full_name"] == "Ada Example"
    assert current["country"] == "DE"
    assert current["updated_at"] == datetime(2026, 3, 1, 8, 0, tzinfo=UTC)
    assert len(rows(db, customers, customer_id="C-7")) == 2
    (order,) = rows(db, orders)
    assert order["customer_id"] == "C-7"


def test_crm_rows_between_the_order_and_the_run_replace_placeholders_too(
    pipeline, db, clock, tmp_path
):
    lines = [
        order_row(order_id="O-1", customer_id="C-7"),
        order_row(order_id="O-2", customer_id="C-8", updated_at="02.03.2026 11:00:00"),
    ]
    pipeline.run("orders", write_orders(tmp_path, lines))

    clock.advance(hours=2)
    crm = [
        # After both orders' updated_at, before the order run.
        customer_obj(customer_id="C-7", email="c7@example.com", updated_at="2026-03-20T12:00:00Z"),
        customer_obj(customer_id="C-8", email="c8@example.com", updated_at="2026-03-31T23:00:00Z"),
    ]
    pipeline.run("customers", write_customers(tmp_path, crm))

    for customer_id, email in (("C-7", "c7@example.com"), ("C-8", "c8@example.com")):
        current = current_version(db, customer_id)
        assert (current["is_placeholder"], current["email"]) == (False, email)
