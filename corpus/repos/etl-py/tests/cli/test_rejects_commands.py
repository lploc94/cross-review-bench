from __future__ import annotations

import json

from etl.infra.tables import rejects
from tests.helpers.db import count
from tests.helpers.factories import customer_obj, product_row, write_customers, write_products


def load_customers_with_rejects(cli, tmp_path, *, bad: int = 3, good: int = 12):
    objects = [customer_obj(customer_id=f"C-{n}") for n in range(good)]
    objects += [customer_obj(customer_id=f"B-{n}", email="ada.example.com") for n in range(bad)]
    result = cli("run", "customers", write_customers(tmp_path, objects))
    assert result.exit_code == 0, result.output


def test_rejects_list_shows_lines_and_reasons_without_values(cli, tmp_path):
    load_customers_with_rejects(cli, tmp_path)

    result = cli("rejects", "list", "1")

    assert result.exit_code == 0, result.output
    lines = result.stdout.splitlines()
    assert lines[0].split() == ["line", "column", "reason"]
    assert [line.split()[0] for line in lines[2:]] == ["13", "14", "15"]
    assert "email" in lines[2]
    assert "ada.example.com" not in result.stdout


def test_rejects_list_pages_through_a_run(cli, tmp_path):
    load_customers_with_rejects(cli, tmp_path)

    first = cli("rejects", "list", "1", "--limit", "2")
    rest = json.loads(cli("rejects", "list", "1", "--after", "14", "--json").stdout)

    assert "more may follow: --after 14" in first.stdout
    assert [item["line_no"] for item in rest] == [15]


def test_rejects_list_filters_by_reason(cli, tmp_path):
    load_customers_with_rejects(cli, tmp_path)
    (reason,) = {
        item["reason"] for item in json.loads(cli("rejects", "list", "1", "--json").stdout)
    }

    matching = cli("rejects", "list", "1", "--reason", reason, "--json")
    other = cli("rejects", "list", "1", "--reason", "something else")

    assert len(json.loads(matching.stdout)) == 3
    assert other.stdout.strip() == "no rejects"


def test_rejects_list_refuses_an_unknown_run_and_a_bad_limit(cli, db):
    assert cli("rejects", "list", "99").exit_code == 4
    assert cli("rejects", "list", "99", "--limit", "0").exit_code == 2


def test_rejects_prune_deletes_rejects_before_the_day(cli, clock, db, tmp_path):
    load_customers_with_rejects(cli, tmp_path)  # 2026-04-01 08:00 UTC
    clock.advance(days=2)
    cli("run", "products", write_products(tmp_path, [product_row(price="x"), product_row()] * 3))
    assert count(db, rejects) == 6

    result = cli("rejects", "prune", "--before", "2026-04-02", "--yes")

    assert result.exit_code == 0, result.output
    assert "deleted 3 rejects recorded before 2026-04-01 22:00:00Z" in result.stdout
    assert count(db, rejects, source="products") == 3
    assert count(db, rejects, source="customers") == 0


def test_rejects_prune_by_source(cli, clock, db, tmp_path):
    load_customers_with_rejects(cli, tmp_path)
    cli("run", "products", write_products(tmp_path, [product_row(price="x"), product_row()] * 3))
    clock.advance(days=1)

    result = cli("rejects", "prune", "--before", "2026-04-02", "--source", "products", "--yes")

    assert result.exit_code == 0, result.output
    assert count(db, rejects, source="products") == 0
    assert count(db, rejects, source="customers") == 3


def test_rejects_prune_asks_first_and_refuses_future_days(cli, db, tmp_path):
    load_customers_with_rejects(cli, tmp_path)

    declined = cli("rejects", "prune", "--before", "2026-04-01", input="n\n")
    future = cli("rejects", "prune", "--before", "2026-04-02", "--yes")
    malformed = cli("rejects", "prune", "--before", "April", "--yes")

    assert declined.exit_code == 1
    assert future.exit_code == 2
    assert "future" in future.stderr
    assert malformed.exit_code == 2
    assert count(db, rejects) == 3
