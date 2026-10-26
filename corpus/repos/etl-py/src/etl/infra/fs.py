"""Filesystem access: source files (plain or gzip) and atomic report files."""

from __future__ import annotations

import gzip
import io
import os
import re
import tempfile
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from pathlib import Path
from typing import BinaryIO, TextIO

GZIP_MAGIC = b"\x1f\x8b"

# The line ends `newline=""` recognises.
_LINE_END = re.compile(rb"\r\n|\r|\n")
_BLOCK_SIZE = 64 * 1024


class SourceLines(io.BufferedIOBase):
    """The bytes of a source file, handed out in pieces that never cross a line end.

    TextIOWrapper decodes each piece as it reads it. A byte that is not valid in the encoding
    therefore fails the read of the piece holding it, and `line_no` is the physical line of that
    byte, however far ahead of the reader the decoding runs. Line ends are those of
    `newline=""`: `\\n`, `\\r\\n` and a lone `\\r`.
    """

    def __init__(self, source: BinaryIO | gzip.GzipFile, name: str) -> None:
        super().__init__()
        self._source = source
        self._name = name
        self._buffer = bytearray()
        self._start = 0
        # The buffer holds no line end between `_start` and here: searches resume from it.
        self._scanned = 0
        self._eof = False
        self._at_line_start = True
        self._line_no = 0

    @property
    def name(self) -> str:
        return self._name

    @property
    def line_no(self) -> int:
        """The physical line (from 1) of the last bytes handed out; 0 before any."""
        return self._line_no

    def readable(self) -> bool:
        return True

    def read1(self, size: int = -1, /) -> bytes:
        """Bytes up to the end of the current line, at most `size` of them when it is not
        negative."""
        end, ends_line = self._line_end(size)
        if 0 <= size < end - self._start:
            end, ends_line = self._start + size, False
        piece = bytes(self._buffer[self._start : end])
        self._start = end
        self._scanned = max(self._scanned, end)
        if piece:
            if self._at_line_start:
                self._line_no += 1
            self._at_line_start = ends_line
        return piece

    def read(self, size: int | None = -1, /) -> bytes:
        limit = -1 if size is None else size
        pieces: list[bytes] = []
        length = 0
        while limit < 0 or length < limit:
            piece = self.read1(-1 if limit < 0 else limit - length)
            if not piece:
                break
            pieces.append(piece)
            length += len(piece)
        return b"".join(pieces)

    def _line_end(self, size: int) -> tuple[int, bool]:
        """Where the line from `_start` ends in the buffer, reading more of the source as
        needed, and whether that is the end of the line: it is not when the buffer already
        holds `size` bytes of the line without its end."""
        while True:
            match = _LINE_END.search(self._buffer, self._scanned)
            # A "\r" at the end of the buffer may be the first half of "\r\n".
            if match is not None and (self._eof or match.end() < len(self._buffer)):
                self._scanned = match.start()
                return match.end(), True
            self._scanned = len(self._buffer) if match is None else match.start()
            if match is None and 0 <= size <= len(self._buffer) - self._start:
                return len(self._buffer), False
            if self._eof:
                return len(self._buffer), True
            self._fill()

    def _fill(self) -> None:
        block = self._source.read(_BLOCK_SIZE)
        if not block:
            self._eof = True
            return
        if self._start:
            del self._buffer[: self._start]
            self._scanned -= self._start
            self._start = 0
        self._buffer += block


def is_gzip(path: Path) -> bool:
    """Whether the file starts with the gzip magic bytes (the suffix is not trusted)."""
    with path.open("rb") as handle:
        return handle.read(len(GZIP_MAGIC)) == GZIP_MAGIC


@contextmanager
def open_text(path: Path, encoding: str) -> Iterator[io.TextIOWrapper[SourceLines]]:
    """Open a source file for streaming text reads, decompressing gzip transparently.

    Newlines are passed through untranslated (`newline=""`) so the csv module sees quoted
    line breaks as they are. Decoding is strict: a byte sequence that is not valid in
    `encoding` raises UnicodeDecodeError while reading, and `.buffer.line_no` is then the
    physical line it is on.
    """
    raw: BinaryIO = path.open("rb")
    try:
        compressed = raw.read(len(GZIP_MAGIC)) == GZIP_MAGIC
        raw.seek(0)
        binary: BinaryIO | gzip.GzipFile = (
            gzip.GzipFile(fileobj=raw, mode="rb") if compressed else raw
        )
        text = io.TextIOWrapper(
            SourceLines(binary, str(path)), encoding=encoding, errors="strict", newline=""
        )
        try:
            yield text
        finally:
            text.detach()
            if binary is not raw:
                binary.close()
    finally:
        raw.close()


def atomic_write_text(
    path: Path, write: Callable[[TextIO], None], *, encoding: str = "utf-8"
) -> Path:
    """Write a file through a temporary sibling and rename it into place.

    Readers see either the previous file or the complete new one, never a partial write.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(descriptor, "w", encoding=encoding, newline="") as handle:
            write(handle)
            handle.flush()
            os.fsync(handle.fileno())
        Path(temporary).replace(path)
    except BaseException:
        Path(temporary).unlink(missing_ok=True)
        raise
    return path
