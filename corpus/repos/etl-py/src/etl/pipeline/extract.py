"""The streaming part of a run: rows from the reader to normalised records in the window."""

from __future__ import annotations

from collections.abc import Iterable, Iterator
from dataclasses import dataclass
from datetime import datetime

from etl.domain.records import Record, RejectedGroups
from etl.pipeline.sink import RejectSink
from etl.pipeline.window import IncrementalWindow
from etl.sources.base import MalformedRow, SourceItem, SourceRow
from etl.sources.registry import SourceSpec
from etl.transform.fields import RowRejected
from etl.transform.normalise import KeyOf, Normaliser, RefuseMalformed, VersionOf


@dataclass(slots=True)
class ExtractCounts:
    read: int = 0
    rejected: int = 0
    skipped: int = 0
    staged: int = 0

    @property
    def reject_ratio(self) -> float:
        return self.rejected / self.read if self.read else 0.0


def extract[R: Record](
    items: Iterable[SourceItem],
    *,
    spec: SourceSpec,
    normalise: Normaliser[R],
    window: IncrementalWindow,
    not_after: datetime,
    sink: RejectSink,
    counts: ExtractCounts,
    version_of: VersionOf | None,
    key_of: KeyOf | None,
    refuse_malformed: RefuseMalformed | None,
    rejected: RejectedGroups,
) -> Iterator[R]:
    """Normalise rows lazily, sending rejects to `sink` and counting as it goes.

    A row is rejected when the reader could not split it, when a value is invalid, or when its
    `updated_at` lies after `not_after` (a clock far ahead on the source would otherwise drag
    the watermark into the future). Valid rows outside the window are skipped. Each rejected
    row's version (`version_of`) is added to `rejected`, or its key (`key_of`, which fails the
    run when the key cannot be read either) when the version cannot be read. With
    `refuse_malformed`, a row the reader could not split is recorded as a reject and then fails
    the run.
    """

    def note_group(row: SourceRow) -> None:
        version = version_of(row, spec) if version_of is not None else None
        if version is not None:
            rejected.versions.add(version)
            return
        if key_of is not None:
            rejected.keys.add(key_of(row, spec))

    def reject(row: SourceRow, reason: str, column: str | None) -> None:
        sink.add(row.line_no, reason, column, dict(row.fields))
        counts.rejected += 1
        note_group(row)

    for item in items:
        counts.read += 1
        if isinstance(item, MalformedRow):
            sink.add(item.line_no, item.reason, None, item.payload)
            counts.rejected += 1
            if refuse_malformed is not None:
                raise refuse_malformed(item)
            continue
        try:
            record = normalise(item, spec)
        except RowRejected as error:
            reject(item, error.reason, error.column)
            continue
        if record.updated_at > not_after:
            reject(item, "updated_at is in the future", "updated_at")
            continue
        if not window.admits(record.updated_at):
            counts.skipped += 1
            continue
        counts.staged += 1
        yield record
