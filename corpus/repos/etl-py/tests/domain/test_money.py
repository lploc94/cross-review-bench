from __future__ import annotations

from decimal import Decimal

import pytest

from etl.domain.money import (
    CURRENCIES,
    Money,
    currency,
    format_amount,
    parse_amount,
    to_minor_units,
    total,
)


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("12,50", Decimal("12.50")),
        ("1.234,56", Decimal("1234.56")),
        ("1.234.567,8", Decimal("1234567.8")),
        ("1234", Decimal("1234")),
        ("-0,5", Decimal("-0.5")),
        ("1 234,50", Decimal("1234.50")),
        ("1\u00a0234,50", Decimal("1234.50")),
        ("1\u202f234,50", Decimal("1234.50")),
        ("1.234", Decimal("1234")),
    ],
)
def test_parses_decimal_comma_amounts(text, expected):
    assert parse_amount(text, ",") == expected


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("12.50", Decimal("12.50")),
        ("1,234.56", Decimal("1234.56")),
        ("0.001", Decimal("0.001")),
        ("1,234", Decimal("1234")),
    ],
)
def test_parses_decimal_point_amounts(text, expected):
    assert parse_amount(text, ".") == expected


@pytest.mark.parametrize(
    ("text", "separator"),
    [
        ("12.5", ","),  # a point in a decimal-comma source is only a thousands separator
        ("1,2,3", ","),
        ("12,5", "."),
        ("1e3", "."),
        ("NaN", "."),
        ("Infinity", "."),
        ("", "."),
        (",", ","),
        ("1.23,4.5", ","),
        ("12,", ","),
    ],
)
def test_refuses_malformed_amounts(text, separator):
    with pytest.raises(ValueError, match="not an amount"):
        parse_amount(text, separator)


def test_refuses_amounts_beyond_the_column_precision():
    with pytest.raises(ValueError, match="too large"):
        parse_amount("1234567890123456", ".")


def test_minor_units_follow_the_currency():
    assert to_minor_units(Decimal("12.5"), currency("EUR")) == Decimal("12.50")
    assert to_minor_units(Decimal("12.500"), currency("eur ")) == Decimal("12.50")
    assert to_minor_units(Decimal("1200"), currency("JPY")) == Decimal("1200")
    assert to_minor_units(Decimal("1.125"), currency("KWD")) == Decimal("1.125")


@pytest.mark.parametrize(
    ("amount", "code"),
    [("12.345", "EUR"), ("100.5", "JPY"), ("1.1251", "BHD")],
)
def test_refuses_more_decimals_than_the_currency_has(amount, code):
    with pytest.raises(ValueError, match="decimal places"):
        to_minor_units(Decimal(amount), currency(code))


def test_unknown_currency_is_refused():
    with pytest.raises(ValueError, match="unknown currency"):
        currency("XYZ")


def test_currency_table_fits_the_warehouse_columns():
    assert all(0 <= unit.minor_units <= 3 for unit in CURRENCIES.values())
    assert all(len(code) == 3 and code.isupper() for code in CURRENCIES)


def test_formats_amounts_in_minor_units():
    assert format_amount(Decimal("1234.5"), currency("EUR")) == "1234.50"
    assert format_amount(Decimal("1200.000"), currency("JPY")) == "1200"
    assert format_amount(Decimal("0.5"), currency("KWD")) == "0.500"


def test_money_adds_within_one_currency_only():
    ten = Money.of(Decimal("10"), "EUR")
    assert str(ten + Money.of(Decimal("2.5"), "EUR")) == "12.50 EUR"
    assert ten.times(3).amount == Decimal("30.00")
    with pytest.raises(ValueError, match="cannot add"):
        ten + Money.of(Decimal("1"), "USD")


def test_total_of_nothing_is_zero_in_the_currency():
    assert total([], "JPY") == Money(Decimal("0"), currency("JPY"))
    amounts = [Money.of(Decimal("0.10"), "EUR")] * 3
    assert total(amounts, "EUR").amount == Decimal("0.30")
