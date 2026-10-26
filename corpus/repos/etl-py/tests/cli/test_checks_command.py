from __future__ import annotations

import json

from sqlalchemy import update

from etl.infra.tables import check_results, products
from etl.quality.registry import CHECKS
from tests.helpers.db import count
from tests.helpers.factories import product_row, write_products


def test_checks_list_shows_every_declared_check(cli, db):
    result = cli("checks", "list")

    assert result.exit_code == 0, result.output
    for check in CHECKS:
        assert check.name in result.stdout
    assert "never run" in result.stdout


def test_checks_list_for_a_source_shows_its_latest_results(cli, tmp_path):
    cli("run", "products", write_products(tmp_path, [product_row()]))

    checks = json.loads(cli("checks", "list", "--source", "products", "--json").stdout)

    assert {check["table"] for check in checks} == {"products"}
    assert all(check["last_passed"] is True and check["last_run_id"] == 1 for check in checks)


def test_checks_list_refuses_an_unknown_source(cli, db):
    assert cli("checks", "list", "--source", "nope").exit_code == 4


def test_checks_run_evaluates_the_warehouse_without_recording(cli, db, tmp_path):
    cli("run", "products", write_products(tmp_path, [product_row()]))
    recorded = count(db, check_results)

    result = cli("checks", "run", "--source", "products")

    assert result.exit_code == 0, result.output
    assert "FAIL" not in result.stdout
    assert count(db, check_results) == recorded


def test_checks_run_exits_with_the_quality_code_on_an_error_level_failure(cli, db, tmp_path):
    cli("run", "products", write_products(tmp_path, [product_row()]))
    with db.begin() as connection:
        connection.execute(update(products).values(currency="ZZZ"))

    result = cli("checks", "run", "--json")

    assert result.exit_code == 13
    failed = [item["check_name"] for item in json.loads(result.stdout) if not item["passed"]]
    assert failed == ["products.currency.accepted_values"]
    assert "products.currency.accepted_values" in result.stderr
