"""Daily sales per country and currency.

A day is a calendar day in the reporting zone: an order placed at 23:30 UTC belongs to the next
day in Berlin. Revenue sums the order totals in each currency separately; cancelled orders are
left out.
"""

from __future__ import annotations

from datetime import date
from zoneinfo import ZoneInfo

from sqlalchemy import Connection, Date, cast, func, select

from etl.domain.money import currency
from etl.domain.timestamps import day_bounds
from etl.infra.tables import orders
from etl.schemas.reports import DailySalesRow

EXCLUDED_STATUSES = ("cancelled",)

HEADER = ("day", "country", "currency", "orders", "revenue")


def daily_sales(
    connection: Connection, *, first: date, last: date, zone: ZoneInfo
) -> list[DailySalesRow]:
    start, end = day_bounds(first, last, zone)
    local_day = cast(func.timezone(zone.key, orders.c.ordered_at), Date).label("day")
    placed = (
        select(local_day, orders.c.country, orders.c.currency, orders.c.total_amount)
        .where(
            orders.c.ordered_at >= start,
            orders.c.ordered_at < end,
            orders.c.status.not_in(EXCLUDED_STATUSES),
        )
        .subquery("placed")
    )
    statement = (
        select(
            placed.c.day,
            placed.c.country,
            placed.c.currency,
            func.count().label("orders"),
            func.sum(placed.c.total_amount).label("revenue"),
        )
        .group_by(placed.c.day, placed.c.country, placed.c.currency)
        .order_by(placed.c.day, placed.c.country, placed.c.currency)
    )
    return [
        DailySalesRow(
            day=row.day,
            country=row.country,
            currency=row.currency,
            orders=int(row.orders),
            revenue=row.revenue.quantize(currency(row.currency).quantum),
        )
        for row in connection.execute(statement)
    ]
