"""What readers produce: data rows with their line numbers, or rows that could not be split."""

from __future__ import annotations

from collections import Counter
from collections.abc import Iterator, Mapping, Sequence
from dataclasses import dataclass
from typing import Protocol

from etl.errors import SchemaMismatch


@dataclass(frozen=True, slots=True)
class SourceRow:
    """One data row: column name to raw value (text for CSV, JSON values for JSON Lines)."""

    line_no: int
    fields: Mapping[str, object]


@dataclass(frozen=True, slots=True)
class MalformedRow:
    """A row the reader could not turn into fields (wrong field count, invalid JSON, ...).

    `payload` is what the reader could recover (the split fields, or the raw line) so that the
    row can be inspected and corrected from `etl.rejects`.
    """

    line_no: int
    reason: str
    payload: object


SourceItem = SourceRow | MalformedRow


class Reader(Protocol):
    """A streaming reader of one source file. Iterating reads the file lazily, row by row."""

    def __iter__(self) -> Iterator[SourceItem]: ...

    @property
    def last_line_no(self) -> int:
        """The last physical line consumed so far, for error messages."""
        ...


def normalise_header(names: Sequence[str]) -> list[str]:
    """Header names trimmed and lower-cased, with a stray byte-order mark removed."""
    return [name.replace("\ufeff", "").strip().lower() for name in names]


def check_header(source: str, header: Sequence[str], required: Sequence[str]) -> None:
    """Refuse a header that lacks a required column or names a column twice.

    Columns the source does not declare are allowed and ignored by the normalisers.
    """
    duplicated = sorted(name for name, count in Counter(header).items() if count > 1 and name)
    present = set(header)
    missing = [name for name in required if name not in present]
    if missing or duplicated:
        raise SchemaMismatch(source, missing=missing, duplicated=duplicated)
