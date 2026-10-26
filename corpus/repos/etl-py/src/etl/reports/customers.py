"""Customer counts per country, now or at the end of a past day (from the type 2 history)."""

from __future__ import annotations

from datetime import datetime

from sqlalchemy import ColumnElement, Connection, and_, func, or_, select

from etl.infra.tables import customers
from etl.schemas.reports import CustomerCountRow

HEADER = ("country", "customers")


def customer_counts(connection: Connection, *, before: datetime | None) -> list[CustomerCountRow]:
    """Customers per country (NULL country last).

    With `before`, counts the versions valid just before that instant: a version valid over
    [valid_from, valid_to) counts when valid_from < before <= valid_to (or it is still open).
    Without it, counts the current versions.
    """
    valid: ColumnElement[bool]
    if before is None:
        valid = customers.c.is_current
    else:
        valid = and_(
            customers.c.valid_from < before,
            or_(customers.c.valid_to.is_(None), customers.c.valid_to >= before),
        )
    count = func.count().label("customers")
    statement = (
        select(customers.c.country, count)
        .where(valid)
        .group_by(customers.c.country)
        .order_by(customers.c.country.asc().nulls_last())
    )
    return [
        CustomerCountRow(country=row.country, customers=int(row.customers))
        for row in connection.execute(statement)
    ]
