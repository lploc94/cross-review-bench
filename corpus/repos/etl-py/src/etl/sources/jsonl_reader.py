"""Streaming JSON Lines reader."""

from __future__ import annotations

import json
from collections.abc import Iterator
from typing import TextIO

from etl.sources.base import MalformedRow, SourceItem, SourceRow


def _refuse_constant(name: str) -> object:
    raise ValueError(f"{name} is not valid JSON")


class JsonLinesReader:
    """Reads one JSON object per line. Blank lines are skipped; a line that is not a JSON
    object is yielded as a MalformedRow carrying the raw line."""

    def __init__(self, handle: TextIO) -> None:
        self._handle = handle
        self._last_line_no = 0

    @property
    def last_line_no(self) -> int:
        return self._last_line_no

    def __iter__(self) -> Iterator[SourceItem]:
        for number, line in enumerate(self._handle, start=1):
            self._last_line_no = number
            text = line.strip()
            if not text:
                continue
            try:
                value = json.loads(text, parse_constant=_refuse_constant)
            except json.JSONDecodeError as error:
                yield MalformedRow(number, f"invalid JSON: {error.msg}", payload=text)
                continue
            except (ValueError, RecursionError) as error:
                yield MalformedRow(number, f"invalid JSON: {error}", payload=text)
                continue
            if not isinstance(value, dict):
                yield MalformedRow(number, "not a JSON object", payload=text)
                continue
            yield SourceRow(number, value)
