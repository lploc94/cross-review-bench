from __future__ import annotations

import json

from tests.helpers.db import HeldLock
from tests.helpers.factories import product_row, write_products


def test_sources_list_shows_every_declared_source(cli):
    result = cli("sources", "list")

    assert result.exit_code == 0, result.output
    names = [line.split()[0] for line in result.stdout.splitlines()[2:]]
    assert names == ["customers", "orders", "products"]


def test_sources_show_describes_how_a_file_is_read(cli):
    result = cli("sources", "show", "orders")

    assert result.exit_code == 0, result.output
    assert "delimiter ';', decimal separator ','" in result.stdout
    assert "naive ones in Europe/Berlin" in result.stdout
    assert "ambiguous times  earlier" in result.stdout
    assert "lookback         6:00:00" in result.stdout


def test_sources_show_as_json(cli):
    view = json.loads(cli("sources", "show", "customers", "--json").stdout)

    assert view["file_format"] == "jsonl"
    assert view["delimiter"] is None
    assert view["required_columns"] == ["customer_id", "updated_at"]
    assert view["lookback"] == "PT1H"


def test_sources_show_refuses_an_unknown_source(cli):
    result = cli("sources", "show", "nope")

    assert result.exit_code == 4
    assert "unknown source" in result.stderr


def test_status_before_any_run(cli, db):
    statuses = json.loads(cli("status", "--json").stdout)

    assert [status["source"] for status in statuses] == ["customers", "orders", "products"]
    assert all(status["last_run_id"] is None and not status["running"] for status in statuses)


def test_status_shows_the_latest_and_the_last_good_run(cli, tmp_path):
    cli("run", "products", write_products(tmp_path, [product_row()]))
    cli("run", "products", write_products(tmp_path, [product_row(price="abc")] * 3))

    (status,) = json.loads(cli("status", "--source", "products", "--json").stdout)

    assert status["last_run_id"] == 2
    assert status["last_status"] == "failed"
    assert status["last_succeeded_run_id"] == 1
    assert status["high_water"] == "2026-03-01T09:00:00Z"


def test_status_shows_a_run_in_progress(cli, db):
    with HeldLock(db, "orders"):
        result = cli("status")

    assert result.exit_code == 0, result.output
    states = {line.split()[0]: line.split()[1] for line in result.stdout.splitlines()[2:]}
    assert states == {"customers": "idle", "orders": "running", "products": "idle"}
