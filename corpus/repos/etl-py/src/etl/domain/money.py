"""Money: exact Decimal amounts in an ISO 4217 currency, with the currency's minor units.

Amounts are never floats. Source text is parsed strictly for the source's decimal separator,
and an amount with more decimals than its currency has (12.345 EUR, 100.5 JPY) is refused, not
rounded: the warehouse stores what the source system charged.
"""

from __future__ import annotations

import re
from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from decimal import ROUND_HALF_EVEN, Context, Decimal, InvalidOperation
from typing import Literal

DecimalSeparator = Literal[",", "."]

# Largest amount the warehouse columns hold: NUMERIC(18, 3).
MAX_DIGITS_BEFORE_POINT = 15

_PRECISE = Context(prec=40)
_LIMIT = Decimal(10) ** MAX_DIGITS_BEFORE_POINT

# Spaces that group digits: space, no-break space, narrow no-break space.
_GROUP_SPACES = str.maketrans("", "", " \u00a0\u202f")


@dataclass(frozen=True, slots=True)
class Currency:
    code: str
    minor_units: int

    @property
    def quantum(self) -> Decimal:
        """The smallest amount of the currency: 0.01 for EUR, 1 for JPY, 0.001 for KWD."""
        return Decimal(1).scaleb(-self.minor_units)


_MINOR_UNITS: tuple[tuple[str, int], ...] = (
    ("AED", 2),
    ("AUD", 2),
    ("BGN", 2),
    ("BHD", 3),
    ("BRL", 2),
    ("CAD", 2),
    ("CHF", 2),
    ("CLP", 0),
    ("CNY", 2),
    ("CZK", 2),
    ("DKK", 2),
    ("EUR", 2),
    ("GBP", 2),
    ("HKD", 2),
    ("HUF", 2),
    ("IDR", 2),
    ("ILS", 2),
    ("INR", 2),
    ("ISK", 0),
    ("JOD", 3),
    ("JPY", 0),
    ("KRW", 0),
    ("KWD", 3),
    ("MXN", 2),
    ("MYR", 2),
    ("NOK", 2),
    ("NZD", 2),
    ("OMR", 3),
    ("PHP", 2),
    ("PLN", 2),
    ("RON", 2),
    ("SAR", 2),
    ("SEK", 2),
    ("SGD", 2),
    ("THB", 2),
    ("TND", 3),
    ("TRY", 2),
    ("TWD", 2),
    ("UAH", 2),
    ("USD", 2),
    ("VND", 0),
    ("ZAR", 2),
)

CURRENCIES: Mapping[str, Currency] = {code: Currency(code, units) for code, units in _MINOR_UNITS}

_AMOUNT_PATTERNS: dict[DecimalSeparator, re.Pattern[str]] = {
    # 1234,5 | 1.234,56 | -0,5
    ",": re.compile(r"^(?P<sign>-?)(?P<int>\d{1,3}(?:\.\d{3})+|\d+)(?:,(?P<frac>\d+))?$"),
    # 1234.5 | 1,234.56 | -0.5
    ".": re.compile(r"^(?P<sign>-?)(?P<int>\d{1,3}(?:,\d{3})+|\d+)(?:\.(?P<frac>\d+))?$"),
}


def currency(code: str) -> Currency:
    """The currency for an ISO 4217 code (case and surrounding spaces ignored)."""
    normalised = code.strip().upper()
    found = CURRENCIES.get(normalised)
    if found is None:
        raise ValueError(f"unknown currency code {code.strip()!r}")
    return found


def parse_amount(text: str, separator: DecimalSeparator) -> Decimal:
    """Parse a decimal amount written with `separator` as the decimal mark.

    The other mark is accepted only as a thousands separator in groups of three. Spaces
    (including no-break spaces) between digit groups are ignored. Exponents, NaN, infinities
    and a lone separator are refused.
    """
    compact = text.strip().translate(_GROUP_SPACES)
    match = _AMOUNT_PATTERNS[separator].match(compact)
    if match is None:
        raise ValueError(f"not an amount with {separator!r} as decimal separator")
    other = "." if separator == "," else ","
    integer = match.group("int").replace(other, "")
    if len(integer.lstrip("0")) > MAX_DIGITS_BEFORE_POINT:
        raise ValueError("amount is too large")
    fraction = match.group("frac") or ""
    sign = match.group("sign")
    literal = f"{sign}{integer}.{fraction}" if fraction else f"{sign}{integer}"
    return Decimal(literal)


def to_minor_units(amount: Decimal, unit: Currency) -> Decimal:
    """`amount` with exactly the currency's number of decimals.

    Raises ValueError when the amount has a non-zero digit beyond the currency's minor units;
    trailing zeros (12.500 EUR) are fine.
    """
    if not amount.is_finite():
        raise ValueError("amount must be finite")
    if abs(amount) >= _LIMIT:
        raise ValueError("amount is too large")
    try:
        exact = amount.quantize(unit.quantum, context=_PRECISE)
    except InvalidOperation as error:
        raise ValueError("amount is too large") from error
    if exact != amount:
        raise ValueError(f"{unit.code} has {unit.minor_units} decimal places")
    return exact


def format_amount(amount: Decimal, unit: Currency) -> str:
    """Plain text of an amount in the currency's minor units, without grouping: 1234.50."""
    return f"{amount.quantize(unit.quantum, rounding=ROUND_HALF_EVEN, context=_PRECISE):f}"


@dataclass(frozen=True, slots=True)
class Money:
    amount: Decimal
    currency: Currency

    @classmethod
    def of(cls, amount: Decimal, code: str) -> Money:
        unit = currency(code)
        return cls(to_minor_units(amount, unit), unit)

    def __add__(self, other: Money) -> Money:
        if other.currency != self.currency:
            raise ValueError(f"cannot add {other.currency.code} to {self.currency.code}")
        return Money(self.amount + other.amount, self.currency)

    def times(self, quantity: int) -> Money:
        return Money(self.amount * quantity, self.currency)

    def __str__(self) -> str:
        return f"{format_amount(self.amount, self.currency)} {self.currency.code}"


def total(amounts: Iterable[Money], code: str) -> Money:
    """The sum of amounts that all share the currency `code` (zero for none)."""
    unit = currency(code)
    result = Money(Decimal(0).quantize(unit.quantum), unit)
    for amount in amounts:
        result = result + amount
    return result
