"""The daily-total anomaly check runs after every orders load: its query must be served by the
index on orders.ordered_at, never by a scan of the whole fact table."""

from __future__ import annotations

from datetime import UTC, date, datetime, time, timedelta
from decimal import Decimal
from typing import Any
from zoneinfo import ZoneInfo

from sqlalchemy import Connection, event, insert

from etl.infra.tables import orders, runs
from etl.quality.registry import build_checks, find_check

BERLIN = ZoneInfo("Europe/Berlin")
YESTERDAY = date(2026, 3, 31)  # the default FrozenClock reads 2026-04-01 10:00 in Berlin


class NoHistory:
    def previous_observed(self, check_name: str) -> Decimal | None:
        return None


def seed(connection: Connection) -> None:
    connection.execute(
        insert(runs).values(
            id=1,
            source="orders",
            path="-",
            status="running",
            started_at=datetime(2026, 4, 1, tzinfo=UTC),
        )
    )
    values: list[dict[str, Any]] = []

    def order(order_id: str, ordered_at: datetime, total: str, currency: str = "EUR") -> None:
        values.append(
            {
                "order_id": order_id,
                "customer_id": "C-1",
                "status": "paid",
                "country": "DE",
                "currency": currency,
                "total_amount": Decimal(total),
                "ordered_at": ordered_at,
                "updated_at": ordered_at,
                "loaded_at": ordered_at,
                "run_id": 1,
            }
        )

    # Old orders far outside the checked days: the bulk of a real fact table.
    for n in range(300):
        order(f"OLD-{n}", datetime(2024, 1, 1, tzinfo=UTC) + timedelta(hours=n), "999.00")
    for back in range(1, 29):
        day = YESTERDAY - timedelta(days=back)
        order(f"H-{back}", datetime.combine(day, time(12), tzinfo=BERLIN), "100.00")
        order(f"P-{back}", datetime.combine(day, time(12), tzinfo=BERLIN), "50.00", "PLN")
    # The edges of the checked range in Berlin time.
    first = YESTERDAY - timedelta(days=28)
    order("EDGE-1", datetime.combine(first, time(0, 30), tzinfo=BERLIN), "40.00")
    order("EDGE-2", datetime.combine(first, time(0), tzinfo=BERLIN) - timedelta(minutes=30), "9e4")
    order("Y-1", datetime(2026, 3, 30, 22, 30, tzinfo=UTC), "350.00")  # 00:30 on Mar 31
    order("T-1", datetime(2026, 3, 31, 22, 30, tzinfo=UTC), "9e4")  # 00:30 on Apr 1
    order("Y-P", datetime(2026, 3, 31, 21, 59, tzinfo=UTC), "60.00", "PLN")  # 23:59 Mar 31
    connection.execute(insert(orders), values)
    connection.exec_driver_sql("ANALYZE warehouse.orders")


def test_the_check_query_uses_the_ordered_at_index_and_finds_the_same_days(db, settings, clock):
    check = find_check("orders.daily_total.anomaly", build_checks(settings, clock))
    assert check is not None
    captured: list[tuple[str, Any]] = []

    def capture(conn, cursor, statement, parameters, context, executemany):
        captured.append((statement, parameters))

    with db.connect() as connection, connection.begin():
        seed(connection)
        event.listen(connection, "before_cursor_execute", capture)
        try:
            outcome = check.evaluate(connection, NoHistory())
        finally:
            event.remove(connection, "before_cursor_execute", capture)

        reading = [(s, p) for s, p in captured if "warehouse.orders" in s]
        assert reading, captured
        connection.exec_driver_sql("SET LOCAL enable_seqscan = off")
        for statement, parameters in reading:
            plan = "\n".join(
                row[0] for row in connection.exec_driver_sql("EXPLAIN " + statement, parameters)
            )
            assert "Seq Scan on orders" not in plan, plan
            assert "ix_orders_ordered_at" in plan, plan
        connection.rollback()

    # EUR: 28 days of 100 plus 40 on the first day (mean 101.43); 350 yesterday is 3.45x.
    # PLN: 28 days of 50; 60 yesterday.
    assert not outcome.passed
    assert outcome.observed == Decimal(1)
    assert outcome.details == "2026-03-31: outside 3x of the mean: EUR 3.45x"
