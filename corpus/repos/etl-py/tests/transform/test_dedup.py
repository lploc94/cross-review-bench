from __future__ import annotations

from sqlalchemy import Column, DateTime, Integer, MetaData, Table, Text
from sqlalchemy.dialects import postgresql

from etl.transform.dedup import latest_order_lines, latest_per_key


def stage() -> Table:
    return Table(
        "stage",
        MetaData(),
        Column("line_no", Integer),
        Column("order_id", Text),
        Column("position", Integer),
        Column("updated_at", DateTime(timezone=True)),
    )


def sql(statement) -> str:
    return str(statement.compile(dialect=postgresql.dialect()))


def test_latest_per_key_orders_by_version_then_line():
    text = sql(latest_per_key(stage(), ["order_id"]))

    assert "SELECT DISTINCT ON (stage.order_id)" in text
    assert "ORDER BY stage.order_id, stage.updated_at DESC, stage.line_no DESC" in text


def test_latest_order_lines_keep_only_the_latest_version():
    text = sql(latest_order_lines(stage()))

    assert "max(stage.updated_at) OVER (PARTITION BY stage.order_id)" in text
    assert "WHERE ranked.updated_at = ranked.version_updated_at" in text
    assert "DISTINCT ON (ranked.order_id, ranked.position)" in text
