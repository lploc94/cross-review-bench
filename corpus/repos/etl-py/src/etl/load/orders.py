"""Orders and their lines: the sales fact tables.

A source row is one order line; the order's own columns repeat on each of its lines. All lines
of one version of an order share its `updated_at`. The latest version in the batch replaces
the stored order, lines included, when it is newer than the stored one. A version is loaded
whole or not at all.
"""

from __future__ import annotations

from typing import Any

from sqlalchemy import (
    BigInteger,
    Column,
    ColumnElement,
    Connection,
    Integer,
    MetaData,
    String,
    Table,
    Text,
    and_,
    bindparam,
    delete,
    distinct,
    func,
    literal,
    or_,
    select,
    tuple_,
)
from sqlalchemy.dialects.postgresql import ARRAY
from sqlalchemy.dialects.postgresql import insert as pg_insert

from etl.domain.records import OrderLineRecord, RejectedGroups
from etl.infra.tables import MONEY, TZ, customers, order_lines, orders, products
from etl.load.base import LoadContext, LoadStats, StagedReject, record_values, temporary_table
from etl.load.upsert import execute_counting, newer_wins_upsert
from etl.transform.dedup import latest_order_lines, latest_per_key

# Order columns repeated on every line; the lines of one version must agree on them.
ORDER_COLUMNS = ("customer_id", "status", "country", "currency", "ordered_at")


class OrdersLoader:
    @property
    def target_tables(self) -> tuple[Table, ...]:
        return (orders, order_lines)

    def stage_table(self, metadata: MetaData) -> Table:
        return temporary_table(
            "stage_order_lines",
            metadata,
            Column("order_id", Text, nullable=False),
            Column("position", Integer, nullable=False),
            Column("customer_id", Text, nullable=False),
            Column("status", Text, nullable=False),
            Column("country", String(2), nullable=False),
            Column("currency", String(3), nullable=False),
            Column("ordered_at", TZ, nullable=False),
            Column("updated_at", TZ, nullable=False),
            Column("product_id", Text, nullable=False),
            Column("quantity", Integer, nullable=False),
            Column("unit_price", MONEY, nullable=False),
            Column("line_amount", MONEY, nullable=False),
        )

    def stage_row(self, record: OrderLineRecord) -> dict[str, Any]:
        return record_values(record)

    def remove_inconsistent(
        self, connection: Connection, stage: Table, rejected: RejectedGroups
    ) -> list[StagedReject]:
        """Reject every staged line of an order version that cannot be loaded whole.

        - Its lines disagree on the order's columns (two currencies, two customers, ...): no
          line of it can be trusted to be the order.
        - A line of the order was rejected and its version could not be read
          (`rejected.keys`): any version of the order in the batch may be the incomplete one,
          so every line of the order is refused.
        - Another of its lines was rejected (`rejected.versions`: order_id and updated_at):
          the rest would replace the stored order with a part of it.
        """
        version = tuple_(stage.c.order_id, stage.c.updated_at)
        disagreeing = (
            select(stage.c.order_id, stage.c.updated_at)
            .group_by(stage.c.order_id, stage.c.updated_at)
            .having(or_(*(func.count(distinct(stage.c[name])) > 1 for name in ORDER_COLUMNS)))
        )
        removed = _remove_lines(
            connection,
            stage,
            version.in_(disagreeing),
            "the lines of this order version disagree on the order's columns",
        )
        if rejected.keys:
            unknown = func.unnest(
                bindparam("unknown_order_ids", sorted(rejected.keys), ARRAY(Text))
            )
            removed += _remove_lines(
                connection,
                stage,
                stage.c.order_id.in_(select(unknown)),
                "another line of this order was rejected and its version is unknown",
            )
        if rejected.versions:
            order_ids, updated_ats = zip(*sorted(rejected.versions), strict=True)
            # Two array parameters, however many versions there are.
            incomplete = (
                func.unnest(
                    bindparam("order_ids", list(order_ids), ARRAY(Text)),
                    bindparam("updated_ats", list(updated_ats), ARRAY(TZ)),
                )
                .table_valued("order_id", "updated_at")
                .render_derived("incomplete")
            )
            removed += _remove_lines(
                connection,
                stage,
                version.in_(select(incomplete.c.order_id, incomplete.c.updated_at)),
                "another line of this order version was rejected",
            )
        return sorted(removed, key=lambda staged: staged.line_no)

    def merge(self, connection: Connection, stage: Table, context: LoadContext) -> LoadStats:
        lines = latest_order_lines(stage).subquery("lines")
        totals = (
            select(lines.c.order_id, func.sum(lines.c.line_amount).label("total_amount"))
            .group_by(lines.c.order_id)
            .subquery("totals")
        )
        # The order's columns come from the last line of its latest version.
        headers = latest_per_key(stage, ["order_id"]).subquery("headers")
        order_rows = select(
            headers.c.order_id,
            headers.c.customer_id,
            customers.c.customer_key,
            headers.c.status,
            headers.c.country,
            headers.c.currency,
            totals.c.total_amount,
            headers.c.ordered_at,
            headers.c.updated_at,
            literal(context.loaded_at, TZ).label("loaded_at"),
            literal(context.run_id, BigInteger).label("run_id"),
        ).select_from(
            headers.join(totals, totals.c.order_id == headers.c.order_id).outerjoin(
                customers,
                and_(
                    customers.c.customer_id == headers.c.customer_id,
                    customers.c.is_current,
                ),
            )
        )
        stats = execute_counting(
            connection, newer_wins_upsert(orders, order_rows, key=["order_id"])
        )

        # Orders this run wrote get the lines of their new version, and only those.
        written = select(orders.c.order_id).where(orders.c.run_id == context.run_id)
        connection.execute(delete(order_lines).where(order_lines.c.order_id.in_(written)))
        line_rows = (
            select(
                lines.c.order_id,
                lines.c.position,
                lines.c.product_id,
                products.c.product_key,
                lines.c.quantity,
                lines.c.unit_price,
                lines.c.line_amount,
            )
            .select_from(lines.outerjoin(products, products.c.product_id == lines.c.product_id))
            .where(lines.c.order_id.in_(written))
        )
        names = [column.name for column in line_rows.selected_columns]
        connection.execute(pg_insert(order_lines).from_select(names, line_rows))
        return stats


def _remove_lines(
    connection: Connection, stage: Table, where: ColumnElement[bool], reason: str
) -> list[StagedReject]:
    removed = connection.execute(
        delete(stage).where(where).returning(stage.c.line_no, stage.c.order_id, stage.c.position)
    ).all()
    return [
        StagedReject(
            line_no=row.line_no,
            reason=reason,
            column=None,
            payload={"order_id": row.order_id, "position": row.position},
        )
        for row in removed
    ]
