from __future__ import annotations

import json

from tests.helpers.db import HeldLock
from tests.helpers.factories import customer_obj, write_customers


def test_show_without_a_watermark(cli, db):
    result = cli("watermark", "show", "orders")

    assert result.exit_code == 0
    assert "no watermark, the next run reads every row" in result.stdout


def test_show_after_a_run(cli, tmp_path):
    cli(
        "run",
        "customers",
        write_customers(tmp_path, [customer_obj(updated_at="2026-03-01T08:00:00Z")]),
    )

    view = json.loads(cli("watermark", "show", "customers", "--json").stdout)

    assert view["high_water"] == "2026-03-01T08:00:00Z"
    assert view["cutoff"] == "2026-03-01T07:00:00Z"
    assert view["lookback"] == "PT1H"


def test_reset_removes_the_watermark_after_confirmation(cli, tmp_path):
    cli("run", "customers", write_customers(tmp_path, [customer_obj()]))

    declined = cli("watermark", "reset", "customers", input="n\n")
    accepted = cli("watermark", "reset", "customers", input="y\n")

    assert declined.exit_code == 1
    assert json.loads(cli("watermark", "show", "customers", "--json").stdout)["high_water"] is None
    assert accepted.exit_code == 0


def test_reset_to_a_given_instant(cli, db):
    result = cli("watermark", "reset", "orders", "--to", "2026-03-01T12:00:00+01:00", "--yes")

    assert result.exit_code == 0, result.output
    assert "high water  2026-03-01 11:00:00Z" in result.stdout


def test_reset_refuses_naive_or_future_instants(cli, db):
    naive = cli("watermark", "reset", "orders", "--to", "2026-03-01T12:00:00", "--yes")
    future = cli("watermark", "reset", "orders", "--to", "2027-01-01T00:00:00Z", "--yes")
    garbage = cli("watermark", "reset", "orders", "--to", "soon", "--yes")

    assert naive.exit_code == future.exit_code == garbage.exit_code == 2
    assert "needs a UTC offset" in naive.stderr


def test_reset_waits_for_no_run(cli, db):
    with HeldLock(db, "orders"):
        result = cli("watermark", "reset", "orders", "--yes")

    assert result.exit_code == 15


def test_list_shows_every_source(cli, tmp_path):
    cli(
        "run",
        "customers",
        write_customers(tmp_path, [customer_obj(updated_at="2026-03-01T08:00:00Z")]),
    )

    result = cli("watermark", "list")

    assert result.exit_code == 0, result.output
    rows = [line.split() for line in result.stdout.splitlines()[2:]]
    assert [row[0] for row in rows] == ["customers", "orders", "products"]
    assert rows[0][1:3] == ["2026-03-01", "08:00:00Z"]
    assert rows[1][1] == "-"
