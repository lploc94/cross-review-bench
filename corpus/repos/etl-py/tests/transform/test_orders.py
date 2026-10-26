from __future__ import annotations

from datetime import UTC, datetime
from decimal import Decimal

import pytest

from etl.sources.base import SourceRow
from etl.sources.registry import ORDERS
from etl.transform.fields import RowRejected
from etl.transform.normalise import normalise_order_line
from tests.helpers.factories import order_row


def normalise(**overrides):
    return normalise_order_line(SourceRow(7, order_row(**overrides)), ORDERS)


def rejected(**overrides) -> RowRejected:
    with pytest.raises(RowRejected) as caught:
        normalise(**overrides)
    return caught.value


def test_an_order_line_is_normalised():
    record = normalise(country=" de ", status="PAID", unit_price="1.234,50", quantity="3")

    assert record.line_no == 7
    assert record.order_id == "O-1"
    assert record.position == 1
    assert record.status == "paid"
    assert record.country == "DE"
    assert record.unit_price == Decimal("1234.50")
    assert record.line_amount == Decimal("3703.50")
    # Berlin winter time: UTC+1
    assert record.ordered_at == datetime(2026, 3, 2, 9, 15, tzinfo=UTC)
    assert record.updated_at == datetime(2026, 3, 2, 9, 20, tzinfo=UTC)


def test_timestamps_without_seconds_are_accepted():
    record = normalise(ordered_at="02.03.2026 10:15", updated_at="02.03.2026 10:15")
    assert record.ordered_at == datetime(2026, 3, 2, 9, 15, tzinfo=UTC)


def test_a_local_time_in_the_dst_gap_is_rejected():
    error = rejected(ordered_at="29.03.2026 02:30:00", updated_at="29.03.2026 04:00:00")
    assert error.column == "ordered_at"
    assert "daylight-saving gap" in error.reason


def test_a_local_time_in_the_dst_fold_takes_the_earlier_instant():
    record = normalise(ordered_at="25.10.2026 02:30:00", updated_at="25.10.2026 02:30:00")
    assert record.ordered_at == datetime(2026, 10, 25, 0, 30, tzinfo=UTC)


def test_a_local_time_before_the_first_utc_instant_is_rejected():
    error = rejected(ordered_at="01.01.0001 00:30:00", updated_at="01.01.0001 00:30:00")
    assert (error.reason, error.column) == ("ordered_at is out of range", "ordered_at")


def test_amounts_follow_the_currency_minor_units():
    assert normalise(currency="jpy", unit_price="1.200").unit_price == Decimal("1200")
    error = rejected(currency="JPY", unit_price="1200,5")
    assert error.column == "unit_price"
    assert "0 decimal places" in error.reason
    assert rejected(unit_price="12,345").column == "unit_price"


@pytest.mark.parametrize(
    ("overrides", "column"),
    [
        ({"quantity": "0"}, "quantity"),
        ({"quantity": "1,5"}, "quantity"),
        ({"unit_price": "-1,00"}, "unit_price"),
        ({"unit_price": "12.5"}, "unit_price"),
        ({"status": "lost"}, "status"),
        ({"currency": "EURO"}, "currency"),
        ({"country": ""}, "country"),
        ({"order_id": "  "}, "order_id"),
        ({"position": "0"}, "position"),
        ({"ordered_at": "2026-03-02 10:15:00"}, "ordered_at"),
    ],
)
def test_invalid_values_reject_the_row_naming_the_column(overrides, column):
    assert rejected(**overrides).column == column


def test_an_order_updated_before_it_was_placed_is_rejected():
    error = rejected(ordered_at="02.03.2026 10:15:00", updated_at="02.03.2026 10:00:00")
    assert error.reason == "updated_at is before ordered_at"


def test_reasons_never_quote_the_value():
    error = rejected(customer_id="secret-\x00-value")
    assert "secret" not in error.reason
    assert error.reason == "customer_id contains a NUL character"
