"""Typed, normalised values from one raw source row.

Every problem with a value raises RowRejected naming the column; the pipeline records the
row in `etl.rejects` and goes on with the next one. Messages never quote the value itself,
which may be personal data.
"""

from __future__ import annotations

import re
from collections.abc import Collection
from datetime import datetime
from decimal import Decimal

from etl.domain import contact, money
from etl.domain.timestamps import AmbiguousTime, NonexistentTime, to_utc
from etl.sources.base import SourceRow
from etl.sources.registry import CsvFormat, SourceSpec

DEFAULT_MAX_LENGTH = 200

_TRUE = frozenset({"true", "t", "yes", "y", "1"})
_FALSE = frozenset({"false", "f", "no", "n", "0"})
_INTEGER = re.compile(r"^[+-]?[0-9]+$")


class RowRejected(Exception):
    """A row that cannot be loaded, with the reason and the column at fault."""

    def __init__(self, reason: str, column: str | None = None) -> None:
        self.reason = reason
        self.column = column
        super().__init__(reason)


class FieldReader:
    """Reads the columns of one row of `spec` with the source's conventions.

    Text is trimmed; an empty or all-blank value counts as missing (NULL) and is refused only
    when the column is required.
    """

    def __init__(self, row: SourceRow, spec: SourceSpec) -> None:
        self._fields = row.fields
        self._spec = spec

    def _raw_text(self, column: str) -> str | None:
        raw = self._fields.get(column)
        if raw is None:
            return None
        if not isinstance(raw, str):
            raise RowRejected(f"{column} must be a string", column)
        if "\x00" in raw:
            raise RowRejected(f"{column} contains a NUL character", column)
        try:
            raw.encode("utf-8")
        except UnicodeEncodeError:
            # A lone surrogate, from a JSON escape such as "\ud800": not a character.
            raise RowRejected(f"{column} is not valid text", column) from None
        return raw.strip() or None

    def optional_text(self, column: str, *, max_length: int = DEFAULT_MAX_LENGTH) -> str | None:
        value = self._raw_text(column)
        if value is not None and len(value) > max_length:
            raise RowRejected(f"{column} is longer than {max_length} characters", column)
        return value

    def text(self, column: str, *, max_length: int = DEFAULT_MAX_LENGTH) -> str:
        value = self.optional_text(column, max_length=max_length)
        if value is None:
            raise RowRejected(f"{column} is missing", column)
        return value

    def choice(self, column: str, allowed: Collection[str]) -> str:
        value = self.text(column).lower()
        if value not in allowed:
            raise RowRejected(f"{column} is not one of {', '.join(sorted(allowed))}", column)
        return value

    def integer(self, column: str, *, minimum: int, maximum: int) -> int:
        raw = self._fields.get(column)
        if isinstance(raw, bool):
            raise RowRejected(f"{column} must be an integer", column)
        if isinstance(raw, int):
            value = raw
        else:
            text = self.text(column)
            if not _INTEGER.match(text):
                raise RowRejected(f"{column} must be an integer", column)
            value = int(text)
        if not minimum <= value <= maximum:
            raise RowRejected(f"{column} must be between {minimum} and {maximum}", column)
        return value

    def boolean(self, column: str, *, default: bool | None) -> bool | None:
        raw = self._fields.get(column)
        if isinstance(raw, bool):
            return raw
        value = self._raw_text(column)
        if value is None:
            return default
        lowered = value.lower()
        if lowered in _TRUE:
            return True
        if lowered in _FALSE:
            return False
        raise RowRejected(f"{column} must be a boolean", column)

    def decimal(self, column: str) -> Decimal:
        text = self.text(column, max_length=40)
        separator: money.DecimalSeparator = (
            self._spec.file_format.decimal_separator
            if isinstance(self._spec.file_format, CsvFormat)
            else "."
        )
        try:
            return money.parse_amount(text, separator)
        except ValueError as error:
            raise RowRejected(f"{column}: {error}", column) from None

    def currency(self, column: str) -> str:
        try:
            return money.currency(self.text(column, max_length=3)).code
        except ValueError:
            raise RowRejected(f"{column} is not a known ISO 4217 currency", column) from None

    def amount(self, column: str, currency_code: str, *, allow_negative: bool = False) -> Decimal:
        """A money amount in `currency_code`, with exactly its minor units."""
        value = self.decimal(column)
        if value < 0 and not allow_negative:
            raise RowRejected(f"{column} must not be negative", column)
        try:
            return money.to_minor_units(value, money.currency(currency_code))
        except ValueError as error:
            raise RowRejected(f"{column}: {error}", column) from None

    def timestamp(self, column: str) -> datetime:
        """An instant in UTC. Naive values are wall-clock times in the source's zone."""
        text = self.text(column, max_length=40)
        parsed = self._parse_timestamp(column, text)
        try:
            return to_utc(parsed, self._spec.tz, self._spec.ambiguous_times)
        except NonexistentTime:
            raise RowRejected(
                f"{column} falls in a daylight-saving gap of {self._spec.zone}", column
            ) from None
        except AmbiguousTime:
            raise RowRejected(
                f"{column} is ambiguous in {self._spec.zone} (daylight-saving fold)", column
            ) from None
        except OverflowError:
            # The instant lies before 0001-01-01 or after 9999-12-31 in UTC.
            raise RowRejected(f"{column} is out of range", column) from None

    def _parse_timestamp(self, column: str, text: str) -> datetime:
        formats = self._spec.timestamp_formats
        if not formats:
            try:
                return datetime.fromisoformat(text)
            except ValueError:
                raise RowRejected(f"{column} is not an ISO 8601 timestamp", column) from None
        for pattern in formats:
            try:
                # Naive on purpose: the caller localizes it in the source's zone.
                return datetime.strptime(text, pattern)  # noqa: DTZ007
            except ValueError:
                continue
        raise RowRejected(f"{column} does not match {' or '.join(formats)}", column)

    def email(self, column: str) -> str | None:
        value = self.optional_text(column, max_length=254)
        if value is None:
            return None
        try:
            return contact.normalise_email(value)
        except ValueError as error:
            raise RowRejected(f"{column}: {error}", column) from None

    def optional_country(self, column: str) -> str | None:
        value = self.optional_text(column, max_length=8)
        if value is None:
            return None
        try:
            return contact.normalise_country(value)
        except ValueError as error:
            raise RowRejected(f"{column}: {error}", column) from None

    def country(self, column: str) -> str:
        value = self.optional_country(column)
        if value is None:
            raise RowRejected(f"{column} is missing", column)
        return value

    def phone(self, column: str, country: str | None) -> str | None:
        value = self.optional_text(column, max_length=40)
        if value is None:
            return None
        try:
            return contact.normalise_phone(value, country)
        except ValueError as error:
            raise RowRejected(f"{column}: {error}", column) from None
