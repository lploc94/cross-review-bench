"""Products: a type 1 dimension, upserted by SKU with newer-wins."""

from __future__ import annotations

from typing import Any

from sqlalchemy import (
    BigInteger,
    Boolean,
    Column,
    Connection,
    MetaData,
    String,
    Table,
    Text,
    literal,
    select,
)

from etl.domain.records import ProductRecord, RejectedGroups
from etl.infra.tables import MONEY, TZ, products
from etl.load.base import LoadContext, LoadStats, StagedReject, record_values, temporary_table
from etl.load.upsert import execute_counting, newer_wins_upsert
from etl.transform.dedup import latest_per_key


class ProductsLoader:
    @property
    def target_tables(self) -> tuple[Table, ...]:
        return (products,)

    def stage_table(self, metadata: MetaData) -> Table:
        return temporary_table(
            "stage_products",
            metadata,
            Column("product_id", Text, nullable=False),
            Column("name", Text, nullable=False),
            Column("category", Text),
            Column("list_price", MONEY, nullable=False),
            Column("currency", String(3), nullable=False),
            Column("active", Boolean, nullable=False),
            Column("updated_at", TZ, nullable=False),
        )

    def stage_row(self, record: ProductRecord) -> dict[str, Any]:
        return record_values(record)

    def remove_inconsistent(
        self, connection: Connection, stage: Table, rejected: RejectedGroups
    ) -> list[StagedReject]:
        return []

    def merge(self, connection: Connection, stage: Table, context: LoadContext) -> LoadStats:
        latest = latest_per_key(stage, ["product_id"]).subquery("latest")
        rows = select(
            latest.c.product_id,
            latest.c.name,
            latest.c.category,
            latest.c.list_price,
            latest.c.currency,
            latest.c.active,
            latest.c.updated_at,
            literal(context.loaded_at, TZ).label("loaded_at"),
            literal(context.run_id, BigInteger).label("run_id"),
        )
        statement = newer_wins_upsert(products, rows, key=["product_id"])
        return execute_counting(connection, statement)
