from __future__ import annotations

import json

from tests.helpers.factories import (
    customer_obj,
    order_row,
    product_row,
    write_customers,
    write_orders,
    write_products,
)


def seed(cli, tmp_path):
    cli("run", "customers", write_customers(tmp_path, [customer_obj()]))
    cli("run", "products", write_products(tmp_path, [product_row()]))
    cli(
        "run",
        "orders",
        write_orders(
            tmp_path, [order_row(), order_row(order_id="O-2", unit_price="1,00", quantity="1")]
        ),
    )


def test_daily_sales_prints_a_table_and_writes_the_csv(cli, tmp_path, settings):
    seed(cli, tmp_path)

    result = cli("report", "daily-sales", "--from", "2026-03-01", "--to", "2026-03-02")

    assert result.exit_code == 0, result.output
    lines = result.stdout.splitlines()
    assert lines[1].split() == ["day", "country", "currency", "orders", "revenue"]
    assert lines[3].split() == ["2026-03-02", "DE", "EUR", "2", "26.00"]
    path = settings.report_dir / "daily_sales_2026-03-01_2026-03-02.csv"
    assert f"written to {path}" in result.stdout
    assert path.read_text().splitlines()[1] == "2026-03-02,DE,EUR,2,26.00"


def test_daily_sales_json(cli, tmp_path):
    seed(cli, tmp_path)

    report = json.loads(cli("report", "daily-sales", "--to", "2026-03-02", "--json").stdout)

    assert report["first_day"] == report["last_day"] == "2026-03-02"
    assert report["rows"] == [
        {"day": "2026-03-02", "country": "DE", "currency": "EUR", "orders": 2, "revenue": "26.00"}
    ]


def test_daily_sales_refuses_bad_dates(cli, db):
    inverted = cli("report", "daily-sales", "--from", "2026-03-02", "--to", "2026-03-01")
    malformed = cli("report", "daily-sales", "--from", "02.03.2026")

    assert inverted.exit_code == 2
    assert "--to is before --from" in inverted.stderr
    assert malformed.exit_code == 2
    assert "not a date" in malformed.output


def test_customer_counts(cli, tmp_path):
    seed(cli, tmp_path)

    result = cli("report", "customers")

    assert result.exit_code == 0, result.output
    assert ["DE", "1"] in [line.split() for line in result.stdout.splitlines()]
    assert "total 1" in result.stdout
