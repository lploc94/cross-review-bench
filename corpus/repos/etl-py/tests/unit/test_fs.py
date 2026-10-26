"""Source files as text: decoding runs line by line, in linear time."""

from __future__ import annotations

import re

from etl.infra import fs
from etl.infra.fs import open_text
from tests.helpers.files import write_text


class CountingPattern:
    """Delegates to a pattern and counts the bytes each search starts with."""

    def __init__(self, pattern: re.Pattern[bytes]) -> None:
        self.pattern = pattern
        self.scanned = 0

    def search(self, data: bytes, pos: int = 0) -> re.Match[bytes] | None:
        self.scanned += len(data) - pos
        return self.pattern.search(data, pos)


def test_a_long_line_is_read_whole_in_linear_time(tmp_path, monkeypatch):
    counting = CountingPattern(fs._LINE_END)
    monkeypatch.setattr(fs, "_LINE_END", counting)
    line = "x" * (4 * 1024 * 1024)
    path = write_text(tmp_path / "long.csv", f"{line}\r\nend\n")

    with open_text(path, "utf-8") as handle:
        text = handle.read()

    assert text == f"{line}\r\nend\n"
    assert counting.scanned < 2 * len(text)
