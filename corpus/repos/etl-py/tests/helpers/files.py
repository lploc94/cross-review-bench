"""Builders that write source files into a test's tmp_path (no binary fixtures in the repo)."""

from __future__ import annotations

import csv
import gzip
import io
import json
from collections.abc import Iterable, Mapping, Sequence
from pathlib import Path


def _write(path: Path, text: str, *, encoding: str, compress: bool) -> Path:
    data = text.encode(encoding)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(gzip.compress(data) if compress else data)
    return path


def csv_text(
    header: Sequence[str],
    rows: Iterable[Mapping[str, object] | Sequence[object]],
    *,
    delimiter: str = ";",
) -> str:
    """CSV text with `header` first. Mapping rows fill missing columns with ""; sequence rows
    are written as they are (to build rows with the wrong number of fields)."""
    buffer = io.StringIO()
    writer = csv.writer(buffer, delimiter=delimiter, lineterminator="\n")
    writer.writerow(header)
    for row in rows:
        if isinstance(row, Mapping):
            writer.writerow(["" if row.get(name) is None else row[name] for name in header])
        else:
            writer.writerow(row)
    return buffer.getvalue()


def write_csv(
    path: Path,
    header: Sequence[str],
    rows: Iterable[Mapping[str, object] | Sequence[object]],
    *,
    delimiter: str = ";",
    encoding: str = "utf-8",
    bom: bool = False,
    compress: bool = False,
) -> Path:
    text = csv_text(header, rows, delimiter=delimiter)
    return _write(path, ("\ufeff" if bom else "") + text, encoding=encoding, compress=compress)


def write_csv_gz(
    path: Path,
    header: Sequence[str],
    rows: Iterable[Mapping[str, object]],
    *,
    delimiter: str = ";",
) -> Path:
    return write_csv(path, header, rows, delimiter=delimiter, compress=True)


def write_jsonl(
    path: Path,
    objects: Iterable[object],
    *,
    raw_lines: Mapping[int, str] | None = None,
    compress: bool = False,
) -> Path:
    """One JSON value per line. `raw_lines` inserts verbatim lines before the given indexes
    (0-based positions in the output), to build invalid JSON."""
    lines = [json.dumps(item) for item in objects]
    for index, line in sorted((raw_lines or {}).items()):
        lines.insert(index, line)
    return _write(path, "\n".join(lines) + "\n", encoding="utf-8", compress=compress)


def write_jsonl_gz(path: Path, objects: Iterable[object]) -> Path:
    return write_jsonl(path, objects, compress=True)


def write_text(path: Path, text: str, *, encoding: str = "utf-8", compress: bool = False) -> Path:
    return _write(path, text, encoding=encoding, compress=compress)
