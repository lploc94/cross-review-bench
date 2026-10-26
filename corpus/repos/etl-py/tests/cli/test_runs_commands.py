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
    cli("run", "products", write_products(tmp_path, [product_row()]))
    cli(
        "run",
        "customers",
        write_customers(
            tmp_path,
            [
                customer_obj(),
                customer_obj(customer_id="C-2", email="bad"),
                *[customer_obj(customer_id=f"K-{n}") for n in range(4)],
            ],
        ),
    )
    cli("run", "orders", write_orders(tmp_path, [order_row(customer_id="nobody")]))


def test_runs_list_shows_the_newest_first(cli, tmp_path):
    seed(cli, tmp_path)

    result = cli("runs", "list")

    assert result.exit_code == 0, result.output
    lines = result.stdout.splitlines()
    assert lines[0].split() == [
        "id",
        "source",
        "status",
        "started",
        "finished",
        "read",
        "loaded",
        "rejected",
    ]
    assert [line.split()[1] for line in lines[2:]] == ["orders", "customers", "products"]


def test_runs_list_filters_and_prints_json(cli, tmp_path):
    seed(cli, tmp_path)

    failed = json.loads(cli("runs", "list", "--status", "failed", "--json").stdout)
    customers = json.loads(cli("runs", "list", "--source", "customers", "--json").stdout)

    assert [run["source"] for run in failed] == ["orders"]
    assert [run["rows_rejected"] for run in customers] == [1]


def test_runs_list_refuses_unknown_sources_and_bad_limits(cli, db):
    assert cli("runs", "list", "--source", "nope").exit_code == 4
    assert cli("runs", "list", "--limit", "0").exit_code == 2
    assert cli("runs", "list", "--status", "lost").exit_code == 2
    assert cli("runs", "list").stdout.strip() == "no runs"


def test_runs_show_includes_checks_and_reject_reasons(cli, tmp_path):
    seed(cli, tmp_path)

    detail = json.loads(cli("runs", "show", "2", "--json").stdout)
    text = cli("runs", "show", "3").stdout

    assert detail["run"]["source"] == "customers"
    assert detail["reject_reasons"] == [
        {"reason": "email: not an email address", "count": 1, "first_line_no": 2}
    ]
    assert {check["check_name"] for check in detail["checks"]} >= {"customers.row_count_delta"}
    table = [line.split()[:3] for line in text.splitlines()]
    assert ["orders.customer_id.references_customers", "error", "FAIL"] in table


def test_runs_show_of_an_unknown_run_exits_with_not_found(cli, db):
    result = cli("runs", "show", "999")

    assert result.exit_code == 4
    assert "run 999 does not exist" in result.stderr
