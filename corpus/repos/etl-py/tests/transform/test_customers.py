from __future__ import annotations

from datetime import UTC, datetime

import pytest

from etl.sources.base import SourceRow
from etl.sources.registry import CUSTOMERS
from etl.transform.fields import RowRejected
from etl.transform.normalise import normalise_customer
from tests.helpers.factories import customer_obj


def normalise(**overrides):
    return normalise_customer(SourceRow(3, customer_obj(**overrides)), CUSTOMERS)


def test_contact_fields_are_normalised():
    record = normalise()

    assert record.customer_id == "C-1"
    assert record.email == "ada.example@example.com"
    assert record.phone == "+49301234567"
    assert record.country == "DE"
    assert record.marketing_opt_in is True
    assert record.updated_at == datetime(2026, 3, 1, 8, 0, tzinfo=UTC)


def test_empty_strings_and_missing_keys_become_null():
    obj = customer_obj(email="  ", full_name="", phone=None, country="")
    del obj["marketing_opt_in"]

    record = normalise_customer(SourceRow(1, obj), CUSTOMERS)

    assert (record.email, record.full_name, record.phone, record.country) == (None,) * 4
    assert record.marketing_opt_in is None


def test_naive_timestamps_are_read_in_the_source_zone_and_offsets_kept():
    assert normalise(updated_at="2026-03-01T08:00:00").updated_at == datetime(
        2026, 3, 1, 8, 0, tzinfo=UTC
    )
    assert normalise(updated_at="2026-03-01T09:00:00+01:00").updated_at == datetime(
        2026, 3, 1, 8, 0, tzinfo=UTC
    )


@pytest.mark.parametrize(
    ("overrides", "column"),
    [
        ({"customer_id": 42}, "customer_id"),
        ({"customer_id": ""}, "customer_id"),
        ({"email": "not-an-address"}, "email"),
        ({"phone": "1234567", "country": None}, "phone"),
        ({"country": "Germany"}, "country"),
        ({"marketing_opt_in": "maybe"}, "marketing_opt_in"),
        ({"updated_at": "yesterday"}, "updated_at"),
        ({"updated_at": None}, "updated_at"),
    ],
)
def test_invalid_values_reject_the_row(overrides, column):
    with pytest.raises(RowRejected) as caught:
        normalise(**overrides)
    assert caught.value.column == column


def test_a_lone_surrogate_is_not_valid_text():
    with pytest.raises(RowRejected) as caught:
        normalise(full_name="Ada \udc00Example")

    assert (caught.value.reason, caught.value.column) == (
        "full_name is not valid text",
        "full_name",
    )


@pytest.mark.parametrize("value", ["0001-01-01T00:30:00+01:00", "9999-12-31T23:30:00-01:00"])
def test_instants_outside_the_datetime_range_reject_the_row(value):
    with pytest.raises(RowRejected) as caught:
        normalise(updated_at=value)

    assert (caught.value.reason, caught.value.column) == (
        "updated_at is out of range",
        "updated_at",
    )
