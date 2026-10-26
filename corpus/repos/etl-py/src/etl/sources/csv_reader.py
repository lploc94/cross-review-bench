"""Streaming CSV reader."""

from __future__ import annotations

import csv
from collections.abc import Iterator, Sequence
from typing import TextIO

from etl.errors import SourceFormatError
from etl.sources.base import MalformedRow, SourceItem, SourceRow, check_header, normalise_header
from etl.sources.registry import CsvFormat


class CsvReader:
    """Reads a delimited file row by row.

    The first record is the header; it must name every required column once. Line numbers
    are physical lines, starting at 1 for the header: a record with a quoted line break
    reports the line it starts on. Empty lines are skipped. A record with a different number
    of fields than the header is yielded as a MalformedRow.
    """

    def __init__(
        self,
        handle: TextIO,
        *,
        source: str,
        file_format: CsvFormat,
        required: Sequence[str],
    ) -> None:
        self._handle = handle
        self._source = source
        self._format = file_format
        self._required = tuple(required)
        self._last_line_no = 0

    @property
    def last_line_no(self) -> int:
        return self._last_line_no

    def __iter__(self) -> Iterator[SourceItem]:
        reader = csv.reader(
            self._handle,
            delimiter=self._format.delimiter,
            quotechar=self._format.quotechar,
            strict=True,
        )
        try:
            raw_header = next(reader)
        except StopIteration:
            raise SourceFormatError("the file is empty: no header row") from None
        self._last_line_no = reader.line_num
        header = normalise_header(raw_header)
        check_header(self._source, header, self._required)
        width = len(header)
        for values in reader:
            start = self._last_line_no + 1
            self._last_line_no = reader.line_num
            if not values:
                continue
            if len(values) != width:
                yield MalformedRow(
                    start,
                    f"expected {width} fields, found {len(values)}",
                    payload=values,
                )
                continue
            yield SourceRow(start, dict(zip(header, values, strict=True)))
