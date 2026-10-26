"""Customers: a slowly changing dimension of type 2.

For each customer in the batch (its latest row), against the stored current version:

- no current version: a new current version starts at the row's updated_at;
- the row is newer and an attribute changed: the current version is closed at the row's
  updated_at and a new current version starts there;
- the row is newer but no attribute changed: the current version only takes the new
  updated_at, so an older row loaded later cannot win;
- the row is not newer: nothing changes.
"""

from __future__ import annotations

from typing import Any

from sqlalchemy import (
    BigInteger,
    Boolean,
    Column,
    ColumnElement,
    Connection,
    MetaData,
    String,
    Table,
    Text,
    and_,
    exists,
    literal,
    not_,
    null,
    or_,
    select,
    true,
    update,
)
from sqlalchemy.dialects.postgresql import insert as pg_insert

from etl.domain.records import CustomerRecord, RejectedGroups
from etl.infra.tables import TZ, customers
from etl.load.base import (
    LoadContext,
    LoadStats,
    StagedReject,
    count_written,
    record_values,
    temporary_table,
)
from etl.transform.dedup import latest_per_key

# Attributes whose change opens a new version.
TRACKED = ("email", "full_name", "phone", "country", "marketing_opt_in")


class CustomersLoader:
    @property
    def target_tables(self) -> tuple[Table, ...]:
        return (customers,)

    def stage_table(self, metadata: MetaData) -> Table:
        return temporary_table(
            "stage_customers",
            metadata,
            Column("customer_id", Text, nullable=False),
            Column("email", Text),
            Column("full_name", Text),
            Column("phone", Text),
            Column("country", String(2)),
            Column("marketing_opt_in", Boolean),
            Column("updated_at", TZ, nullable=False),
        )

    def stage_row(self, record: CustomerRecord) -> dict[str, Any]:
        return record_values(record)

    def remove_inconsistent(
        self, connection: Connection, stage: Table, rejected: RejectedGroups
    ) -> list[StagedReject]:
        return []

    def merge(self, connection: Connection, stage: Table, context: LoadContext) -> LoadStats:
        latest = latest_per_key(stage, ["customer_id"]).subquery("latest")
        current = customers
        newer_current = and_(
            current.c.customer_id == latest.c.customer_id,
            current.c.is_current,
            latest.c.updated_at > current.c.updated_at,
        )
        changed: ColumnElement[bool] = or_(
            *(current.c[name].is_distinct_from(latest.c[name]) for name in TRACKED)
        )

        closed = count_written(
            connection,
            update(current)
            .where(newer_current, changed)
            .values(valid_to=latest.c.updated_at, is_current=False)
            .returning(current.c.customer_key),
        )
        touched = count_written(
            connection,
            update(current)
            .where(newer_current, not_(changed))
            .values(
                updated_at=latest.c.updated_at,
                loaded_at=context.loaded_at,
                run_id=context.run_id,
            )
            .returning(current.c.customer_key),
        )

        has_current = exists().where(
            current.c.customer_id == latest.c.customer_id, current.c.is_current
        )
        new_versions = select(
            latest.c.customer_id,
            *(latest.c[name] for name in TRACKED),
            latest.c.updated_at.label("valid_from"),
            null().label("valid_to"),
            true().label("is_current"),
            latest.c.updated_at,
            literal(context.loaded_at, TZ).label("loaded_at"),
            literal(context.run_id, BigInteger).label("run_id"),
        ).where(not_(has_current))
        names = [column.name for column in new_versions.selected_columns]
        inserted = count_written(
            connection,
            pg_insert(current).from_select(names, new_versions).returning(current.c.customer_key),
        )
        # Every closed version was followed by a new one; the remaining inserts are customers
        # the warehouse did not know.
        return LoadStats(inserted=inserted - closed, updated=closed + touched)
