"""Deduplication inside one batch, as queries over the run's staging table.

Rows are staged as they stream in, so a batch is never held in memory; these selects keep,
for each natural key, the row the source wrote last: the greatest `updated_at`, and on a tie
the row further down the file (greatest `line_no`).
"""

from __future__ import annotations

from collections.abc import Sequence

from sqlalchemy import ColumnElement, Select, Table, func, select
from sqlalchemy.dialects.postgresql import distinct_on


def latest_per_key(stage: Table, key: Sequence[str]) -> Select[tuple[object, ...]]:
    """One row per natural key: the latest by updated_at, ties broken by line number."""
    key_columns: list[ColumnElement[object]] = [stage.c[name] for name in key]
    return (
        select(*stage.c)
        .ext(distinct_on(*key_columns))
        .order_by(*key_columns, stage.c.updated_at.desc(), stage.c.line_no.desc())
    )


def latest_order_lines(stage: Table) -> Select[tuple[object, ...]]:
    """The lines of each order's latest version.

    An order is written as several rows (one per line) that share its `updated_at`. The
    version with the greatest `updated_at` replaces the whole order, so a line that the latest
    version no longer has is dropped. Within that version, a position given twice keeps the
    row further down the file.
    """
    latest = func.max(stage.c.updated_at).over(partition_by=stage.c.order_id)
    ranked = select(*stage.c, latest.label("version_updated_at")).subquery("ranked")
    columns = [ranked.c[column.name] for column in stage.c]
    return (
        select(*columns)
        .where(ranked.c.updated_at == ranked.c.version_updated_at)
        .ext(distinct_on(ranked.c.order_id, ranked.c.position))
        .order_by(ranked.c.order_id, ranked.c.position, ranked.c.line_no.desc())
    )
