from __future__ import annotations

from datetime import UTC, datetime
from decimal import Decimal

import pytest

from etl.sources.base import SourceRow
from etl.sources.registry import PRODUCTS
from etl.transform.fields import RowRejected
from etl.transform.normalise import normalise_product
from tests.helpers.factories import product_row


def normalise(**overrides):
    return normalise_product(SourceRow(2, product_row(**overrides)), PRODUCTS)


def test_a_product_row_is_normalised():
    record = normalise(price="1,299.9", currency="usd")

    assert record.product_id == "SKU-1"
    assert record.list_price == Decimal("1299.90")
    assert record.currency == "USD"
    assert record.active is True
    assert record.category == "kitchen"
    assert record.updated_at == datetime(2026, 3, 1, 9, 0, tzinfo=UTC)


@pytest.mark.parametrize(("value", "expected"), [("", True), ("no", False), ("1", True)])
def test_active_defaults_to_true(value, expected):
    assert normalise(active=value).active is expected


def test_an_empty_optional_column_is_null():
    assert normalise(category="  ").category is None


@pytest.mark.parametrize(
    ("overrides", "column"),
    [
        ({"price": "12,50"}, "price"),
        ({"price": "12.505"}, "price"),
        ({"name": ""}, "name"),
        ({"name": "x" * 201}, "name"),
        ({"active": "sometimes"}, "active"),
    ],
)
def test_invalid_values_reject_the_row(overrides, column):
    with pytest.raises(RowRejected) as caught:
        normalise(**overrides)
    assert caught.value.column == column
