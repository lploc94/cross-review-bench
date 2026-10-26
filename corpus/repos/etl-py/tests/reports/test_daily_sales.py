from __future__ import annotations

from datetime import UTC, date, datetime
from decimal import Decimal

import pytest

from etl.api.reports import daily_sales_report
from etl.errors import InvalidRequest
from tests.helpers.factories import (
    customer_obj,
    order_row,
    product_row,
    write_customers,
    write_orders,
    write_products,
)


def load_orders(pipeline, tmp_path, rows):
    pipeline.run("customers", write_customers(tmp_path, [customer_obj()]))
    pipeline.run("products", write_products(tmp_path, [product_row()]))
    pipeline.run("orders", write_orders(tmp_path, rows))


def test_orders_fall_on_calendar_days_of_the_reporting_zone(pipeline, context, tmp_path):
    load_orders(
        pipeline,
        tmp_path,
        [
            # 23:30 Berlin on 2 March is 22:30 UTC: still 2 March
            order_row(
                order_id="A", ordered_at="02.03.2026 23:30:00", updated_at="03.03.2026 01:00:00"
            ),
            # 00:30 Berlin on 3 March is 23:30 UTC on 2 March: 3 March in Berlin
            order_row(
                order_id="B", ordered_at="03.03.2026 00:30:00", updated_at="03.03.2026 01:00:00"
            ),
            order_row(
                order_id="C",
                ordered_at="03.03.2026 12:00:00",
                updated_at="03.03.2026 12:00:00",
                status="cancelled",
            ),
            order_row(
                order_id="D",
                ordered_at="03.03.2026 13:00:00",
                updated_at="03.03.2026 13:00:00",
                country="fr",
            ),
            order_row(
                order_id="E",
                ordered_at="03.03.2026 14:00:00",
                updated_at="03.03.2026 14:00:00",
                currency="USD",
            ),
        ],
    )

    report = daily_sales_report(context, first=date(2026, 3, 2), last=date(2026, 3, 3))

    assert [
        (r.day.isoformat(), r.country, r.currency, r.orders, r.revenue) for r in report.rows
    ] == [
        ("2026-03-02", "DE", "EUR", 1, Decimal("25.00")),
        ("2026-03-03", "DE", "EUR", 1, Decimal("25.00")),
        ("2026-03-03", "DE", "USD", 1, Decimal("25.00")),
        ("2026-03-03", "FR", "EUR", 1, Decimal("25.00")),
    ]
    assert report.zone == "Europe/Berlin"


def test_the_range_includes_both_ends_and_nothing_outside(pipeline, context, tmp_path):
    load_orders(
        pipeline,
        tmp_path,
        [
            order_row(
                order_id="before",
                ordered_at="28.02.2026 23:59:59",
                updated_at="01.03.2026 08:00:00",
            ),
            order_row(
                order_id="first", ordered_at="01.03.2026 00:00:00", updated_at="01.03.2026 08:00:00"
            ),
            order_row(
                order_id="last", ordered_at="02.03.2026 23:59:59", updated_at="03.03.2026 08:00:00"
            ),
            order_row(
                order_id="after", ordered_at="03.03.2026 00:00:00", updated_at="03.03.2026 08:00:00"
            ),
        ],
    )

    report = daily_sales_report(context, first=date(2026, 3, 1), last=date(2026, 3, 2))

    assert [(r.day.isoformat(), r.orders) for r in report.rows] == [
        ("2026-03-01", 1),
        ("2026-03-02", 1),
    ]


def test_the_report_is_written_as_csv_with_minor_units(pipeline, context, tmp_path):
    load_orders(
        pipeline,
        tmp_path,
        [
            order_row(order_id="Y", currency="JPY", unit_price="1.500", quantity="2"),
            order_row(order_id="E", unit_price="0,10", quantity="3"),
        ],
    )

    report = daily_sales_report(context, first=date(2026, 3, 2), last=date(2026, 3, 2))

    assert report.path == context.settings.report_dir / "daily_sales_2026-03-02_2026-03-02.csv"
    assert report.path.read_text().splitlines() == [
        "day,country,currency,orders,revenue",
        "2026-03-02,DE,EUR,1,0.30",
        "2026-03-02,DE,JPY,1,3000",
    ]
    assert list(report.path.parent.iterdir()) == [report.path]


def test_the_default_day_is_yesterday_in_the_reporting_zone(context, db, clock):
    clock.set(datetime(2026, 3, 9, 23, 30, tzinfo=UTC))  # already 10 March in Berlin

    report = daily_sales_report(context)

    assert (report.first_day, report.last_day) == (date(2026, 3, 9), date(2026, 3, 9))
    assert report.rows == []


def test_invalid_ranges_are_refused(context, db):
    with pytest.raises(InvalidRequest, match="before"):
        daily_sales_report(context, first=date(2026, 3, 2), last=date(2026, 3, 1))
    with pytest.raises(InvalidRequest, match="at most 366 days"):
        daily_sales_report(context, first=date(2025, 1, 1), last=date(2026, 1, 2))
    report = daily_sales_report(context, first=date(2025, 1, 1), last=date(2026, 1, 1))
    assert report.rows == []
