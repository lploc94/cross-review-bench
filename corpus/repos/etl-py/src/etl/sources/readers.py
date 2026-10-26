"""Opening a source file with the reader its format needs."""

from __future__ import annotations

import csv
import gzip
import zlib
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

from etl.errors import SourceFileNotFound, SourceFormatError
from etl.infra.fs import SourceLines, open_text
from etl.sources.base import Reader, SourceItem
from etl.sources.csv_reader import CsvReader
from etl.sources.jsonl_reader import JsonLinesReader
from etl.sources.registry import CsvFormat, JsonLinesFormat, SourceSpec


@contextmanager
def open_reader(spec: SourceSpec, path: Path) -> Iterator[Iterator[SourceItem]]:
    """Open `path` as a file of `spec` and give a lazy iterator over its rows.

    Problems that make the rest of the file unreadable (damaged gzip data, bytes that are not
    valid in the source's encoding, broken CSV quoting) raise SourceFormatError.
    """
    if not path.is_file():
        raise SourceFileNotFound(str(path))
    file_format = spec.file_format
    with open_text(path, file_format.encoding) as handle:
        reader: Reader
        match file_format:
            case CsvFormat():
                reader = CsvReader(
                    handle,
                    source=spec.name,
                    file_format=file_format,
                    required=spec.required_columns,
                )
            case JsonLinesFormat():
                reader = JsonLinesReader(handle)
        yield _guarded(reader, handle.buffer, file_format.encoding)


def _guarded(reader: Reader, lines: SourceLines, encoding: str) -> Iterator[SourceItem]:
    try:
        yield from reader
    except UnicodeDecodeError:
        # The decoder runs ahead of the reader; `lines` knows the line it failed on.
        raise SourceFormatError(
            f"the file is not valid {encoding} text", line_no=lines.line_no
        ) from None
    except (gzip.BadGzipFile, EOFError, zlib.error):
        raise SourceFormatError(
            "the gzip data is damaged or truncated", line_no=reader.last_line_no + 1
        ) from None
    except csv.Error as error:
        raise SourceFormatError(f"broken CSV: {error}", line_no=reader.last_line_no + 1) from None
