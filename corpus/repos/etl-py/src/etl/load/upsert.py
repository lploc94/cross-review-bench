"""Newer-wins upserts: INSERT ... ON CONFLICT (natural key) DO UPDATE ... WHERE newer."""

from __future__ import annotations

from collections.abc import Sequence
from typing import Any

from sqlalchemy import Boolean, Connection, Select, Table, literal_column
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.sql.dml import ReturningInsert

from etl.load.base import LoadStats


def newer_wins_upsert(
    target: Table,
    rows: Select[tuple[object, ...]],
    *,
    key: Sequence[str],
    version: str = "updated_at",
) -> ReturningInsert[Any]:
    """Insert `rows` into `target`; on a key conflict, update only when the incoming
    `version` is strictly newer than the stored one.

    An equal version leaves the stored row alone, so loading the same file twice writes
    nothing the second time. `rows` must hold each key at most once. The statement returns one
    row per written row, with `inserted` true for a new key.
    """
    names = [column.name for column in rows.selected_columns]
    unknown = [name for name in (*key, version) if name not in names]
    if unknown:
        raise ValueError(f"rows lack the columns {unknown}")
    statement = pg_insert(target).from_select(names, rows)
    excluded = statement.excluded
    updates = {name: excluded[name] for name in names if name not in key}
    return statement.on_conflict_do_update(
        index_elements=list(key),
        set_=updates,
        where=target.c[version] < excluded[version],
    ).returning(literal_column("(xmax = 0)", Boolean).label("inserted"))


def execute_counting(connection: Connection, statement: ReturningInsert[Any]) -> LoadStats:
    """Run an upsert built by newer_wins_upsert and count inserted and updated rows."""
    inserted = updated = 0
    for row in connection.execute(statement):
        if row.inserted:
            inserted += 1
        else:
            updated += 1
    return LoadStats(inserted=inserted, updated=updated)
