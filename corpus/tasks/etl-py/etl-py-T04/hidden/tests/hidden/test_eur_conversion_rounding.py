"""Converted report cells are exact Decimal sums, rounded half-even to cents once."""

from __future__ import annotations

import math
from datetime import date
from decimal import ROUND_HALF_EVEN, Decimal

from etl.api.fx import load_rates
from etl.api.reports import daily_sales_report
from tests.helpers.factories import customer_obj, order_row, write_customers, write_orders
from tests.helpers.files import write_text

CENT = Decimal("0.01")


def float_path(parts: list[tuple[Decimal, Decimal]]) -> Decimal:
    total = math.fsum(float(amount) * float(rate) for amount, rate in parts)
    return Decimal(str(total)).quantize(CENT, rounding=ROUND_HALF_EVEN)


def exact_path(parts: list[tuple[Decimal, Decimal]]) -> Decimal:
    total = sum((amount * rate for amount, rate in parts), Decimal(0))
    return total.quantize(CENT, rounding=ROUND_HALF_EVEN)


def test_converted_cells_equal_the_exact_decimal_result(pipeline, context, tmp_path):
    pipeline.run("customers", write_customers(tmp_path, [customer_obj()]))
    pipeline.run(
        "orders",
        write_orders(
            tmp_path,
            [
                # 2 March: 12.50 EUR and 9.00 USD
                order_row(
                    order_id="A",
                    unit_price="6,25",
                    ordered_at="02.03.2026 09:00:00",
                    updated_at="02.03.2026 09:00:00",
                ),
                order_row(
                    order_id="B",
                    currency="USD",
                    unit_price="4,50",
                    ordered_at="02.03.2026 10:00:00",
                    updated_at="02.03.2026 10:00:00",
                ),
                # 3 March: 2.60 USD and, in France, 21.40 USD
                order_row(
                    order_id="C",
                    currency="USD",
                    unit_price="2,60",
                    quantity="1",
                    ordered_at="03.03.2026 09:00:00",
                    updated_at="03.03.2026 09:00:00",
                ),
                order_row(
                    order_id="D",
                    currency="USD",
                    country="fr",
                    unit_price="10,70",
                    ordered_at="03.03.2026 09:30:00",
                    updated_at="03.03.2026 09:30:00",
                ),
                # 4 March: 12.50 EUR and 5.80 USD
                order_row(
                    order_id="E",
                    unit_price="6,25",
                    ordered_at="04.03.2026 09:00:00",
                    updated_at="04.03.2026 09:00:00",
                ),
                order_row(
                    order_id="F",
                    currency="USD",
                    unit_price="2,90",
                    ordered_at="04.03.2026 10:00:00",
                    updated_at="04.03.2026 10:00:00",
                ),
            ],
        ),
    )
    rates = (
        "day,currency,rate_to_eur\n"
        "2026-03-02,USD,0.925\n2026-03-03,USD,0.925\n2026-03-04,USD,0.925\n"
    )
    load_rates(context, write_text(tmp_path / "rates.csv", rates))
    rate = Decimal("0.925")
    cells = {
        ("2026-03-02", "DE"): [(Decimal("12.50"), Decimal(1)), (Decimal("9.00"), rate)],
        ("2026-03-03", "DE"): [(Decimal("2.60"), rate)],
        ("2026-03-03", "FR"): [(Decimal("21.40"), rate)],
        ("2026-03-04", "DE"): [(Decimal("12.50"), Decimal(1)), (Decimal("5.80"), rate)],
    }
    expected = {key: exact_path(parts) for key, parts in cells.items()}
    # The chosen amounts sit on a half cent, where binary floating point lands on either side.
    assert all(float_path(parts) != expected[key] for key, parts in cells.items())

    report = daily_sales_report(
        context, first=date(2026, 3, 2), last=date(2026, 3, 4), convert_to="EUR"
    )

    assert {(row.day.isoformat(), row.country): row.revenue for row in report.rows} == expected
    assert expected == {
        ("2026-03-02", "DE"): Decimal("20.82"),
        ("2026-03-03", "DE"): Decimal("2.40"),
        ("2026-03-03", "FR"): Decimal("19.80"),
        ("2026-03-04", "DE"): Decimal("17.86"),
    }
    lines = report.path.read_text().splitlines()
    assert lines[1:] == [
        "2026-03-02,DE,EUR,2,20.82",
        "2026-03-03,DE,EUR,1,2.40",
        "2026-03-03,FR,EUR,1,19.80",
        "2026-03-04,DE,EUR,2,17.86",
    ]
