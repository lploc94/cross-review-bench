"""Incremental loads: the watermark window, its advance and its compare-and-set."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import text

from etl.errors import WatermarkConflict
from etl.infra.db import create_db_engine
from etl.infra.tables import customers, runs
from etl.pipeline.runner import Pipeline
from etl.pipeline.window import IncrementalWindow
from etl.store import watermarks
from etl.store.watermarks import Watermark
from tests.helpers.db import count, rows
from tests.helpers.factories import customer_obj, product_row, write_customers, write_products

HIGH_WATER = datetime(2026, 3, 10, 12, 0, tzinfo=UTC)  # customers look back one hour


def set_watermark(db, source, value):
    with db.begin() as connection:
        watermarks.reset(connection, source, to=value, now=value)


def high_water(db, source="customers"):
    with db.connect() as connection:
        stored = watermarks.read(connection, source)
    return stored.high_water if stored else None


def stamp(moment: datetime) -> str:
    return moment.isoformat().replace("+00:00", "Z")


def test_the_window_starts_strictly_after_the_watermark_minus_the_lookback():
    window = IncrementalWindow(HIGH_WATER, timedelta(hours=1))
    cutoff = HIGH_WATER - timedelta(hours=1)

    assert window.cutoff == cutoff
    assert not window.admits(cutoff)
    assert window.admits(cutoff + timedelta(microseconds=1))
    assert IncrementalWindow(None, timedelta(hours=1)).admits(datetime(1970, 1, 1, tzinfo=UTC))


def test_the_window_only_moves_the_watermark_forward():
    window = IncrementalWindow(HIGH_WATER, timedelta(hours=1))

    assert window.advance(None) is None
    assert window.advance(HIGH_WATER - timedelta(minutes=5)) is None
    assert window.advance(HIGH_WATER) is None
    assert window.advance(HIGH_WATER + timedelta(seconds=1)) == HIGH_WATER + timedelta(seconds=1)
    assert IncrementalWindow(None, timedelta(0)).advance(HIGH_WATER) == HIGH_WATER


def test_a_watermark_within_the_lookback_of_the_earliest_instant_saturates():
    earliest = datetime.min.replace(tzinfo=UTC)
    window = IncrementalWindow(earliest + timedelta(minutes=30), timedelta(hours=1))

    assert window.cutoff == earliest
    assert window.admits(earliest + timedelta(microseconds=1))


def test_a_row_stamped_at_the_start_of_the_calendar_does_not_break_later_runs(
    pipeline, cli, db, tmp_path
):
    earliest = product_row(sku="A", updated_at="0001-01-01T00:30:00Z")
    pipeline.run("products", write_products(tmp_path, [earliest], name="a.csv"))

    result = pipeline.run(
        "products", write_products(tmp_path, [product_row(sku="B")], name="b.csv")
    )
    shown = cli("watermark", "show", "products")

    assert result.counts.loaded == 1
    assert shown.exit_code == 0, shown.output


def test_instants_load_back_whatever_the_time_zone_of_the_client(
    db, migrated_database, settings, clock, tmp_path, monkeypatch
):
    monkeypatch.setenv("PGTZ", "America/New_York")  # libpq sets the session's TimeZone from it
    engine = create_db_engine(migrated_database, pool_size=3)
    try:
        with engine.connect() as connection:
            assert connection.execute(text("SHOW TimeZone")).scalar_one() == "UTC"
        pipeline = Pipeline(engine, settings, clock)
        earliest = product_row(sku="A", updated_at="0001-01-01T00:30:00Z")
        pipeline.run("products", write_products(tmp_path, [earliest], name="a.csv"))

        result = pipeline.run("products", write_products(tmp_path, [product_row()], name="b.csv"))
    finally:
        engine.dispose()

    assert result.counts.loaded == 1


def test_rows_at_or_before_the_cutoff_are_skipped(pipeline, db, tmp_path):
    set_watermark(db, "customers", HIGH_WATER)
    cutoff = HIGH_WATER - timedelta(hours=1)
    path = write_customers(
        tmp_path,
        [
            customer_obj(customer_id="at-cutoff", updated_at=stamp(cutoff)),
            customer_obj(customer_id="before", updated_at=stamp(cutoff - timedelta(days=1))),
            customer_obj(customer_id="late", updated_at=stamp(cutoff + timedelta(seconds=1))),
            customer_obj(customer_id="new", updated_at=stamp(HIGH_WATER + timedelta(hours=2))),
        ],
    )

    result = pipeline.run("customers", path)

    loaded = sorted(row["customer_id"] for row in rows(db, customers))
    assert loaded == ["late", "new"]
    assert (result.counts.read, result.counts.skipped, result.counts.loaded) == (4, 2, 2)
    assert high_water(db) == HIGH_WATER + timedelta(hours=2)


def test_the_first_run_takes_everything_and_sets_the_watermark(pipeline, db, tmp_path):
    path = write_customers(
        tmp_path,
        [
            customer_obj(customer_id="a", updated_at="2026-03-02T00:00:00Z"),
            customer_obj(customer_id="b", updated_at="2026-03-01T00:00:00Z"),
        ],
    )

    result = pipeline.run("customers", path)

    assert result.counts.loaded == 2
    assert result.high_water == datetime(2026, 3, 2, tzinfo=UTC)
    assert high_water(db) == datetime(2026, 3, 2, tzinfo=UTC)


def test_late_rows_inside_the_lookback_do_not_move_the_watermark_back(pipeline, db, tmp_path):
    set_watermark(db, "customers", HIGH_WATER)
    late = customer_obj(updated_at=stamp(HIGH_WATER - timedelta(minutes=30)))

    result = pipeline.run("customers", write_customers(tmp_path, [late]))

    assert result.counts.loaded == 1
    assert high_water(db) == HIGH_WATER
    assert result.high_water == HIGH_WATER


def test_a_run_with_nothing_new_leaves_the_watermark(pipeline, db, tmp_path):
    set_watermark(db, "customers", HIGH_WATER)
    old = customer_obj(updated_at=stamp(HIGH_WATER - timedelta(days=3)))

    result = pipeline.run("customers", write_customers(tmp_path, [old]))

    assert result.counts.skipped == 1
    assert high_water(db) == HIGH_WATER


def test_the_watermark_is_not_advanced_by_a_failed_run(pipeline, db, tmp_path):
    set_watermark(db, "customers", HIGH_WATER)
    bad = [customer_obj(customer_id=f"C-{n}", email="nope") for n in range(3)]
    good = customer_obj(customer_id="ok", updated_at=stamp(HIGH_WATER + timedelta(days=1)))

    with pytest.raises(Exception, match="rejected"):
        pipeline.run("customers", write_customers(tmp_path, [*bad, good]))

    assert high_water(db) == HIGH_WATER
    assert count(db, customers) == 0


def test_a_watermark_changed_during_the_run_fails_it(pipeline, db, tmp_path, monkeypatch):
    set_watermark(db, "customers", HIGH_WATER)
    stale = Watermark("customers", HIGH_WATER - timedelta(days=1), HIGH_WATER)
    monkeypatch.setattr(watermarks, "read", lambda connection, source: stale)
    row = customer_obj(updated_at=stamp(HIGH_WATER + timedelta(hours=1)))

    with pytest.raises(WatermarkConflict) as caught:
        pipeline.run("customers", write_customers(tmp_path, [row]))

    monkeypatch.undo()
    assert count(db, customers) == 0
    assert high_water(db) == HIGH_WATER
    (run,) = rows(db, runs)
    assert run["status"] == "failed"
    assert run["id"] == caught.value.run_id


def test_compare_and_set_refuses_stale_expectations(db):
    now = datetime(2026, 3, 10, tzinfo=UTC)
    with db.begin() as connection:
        watermarks.advance(connection, "orders", expected=None, new=HIGH_WATER, now=now)
        with pytest.raises(WatermarkConflict):
            watermarks.advance(connection, "orders", expected=None, new=HIGH_WATER, now=now)
        with pytest.raises(WatermarkConflict):
            watermarks.advance(
                connection,
                "orders",
                expected=HIGH_WATER - timedelta(seconds=1),
                new=HIGH_WATER + timedelta(hours=1),
                now=now,
            )
        with pytest.raises(ValueError, match="backwards"):
            watermarks.advance(
                connection, "orders", expected=HIGH_WATER, new=HIGH_WATER - timedelta(1), now=now
            )
        watermarks.advance(
            connection, "orders", expected=HIGH_WATER, new=HIGH_WATER + timedelta(1), now=now
        )
    assert high_water(db, "orders") == HIGH_WATER + timedelta(1)


def test_rows_from_the_future_are_rejected_beyond_the_allowed_skew(pipeline, db, tmp_path, clock):
    now = clock.now()
    path = write_customers(
        tmp_path,
        [
            customer_obj(customer_id=f"ok-{n}", updated_at=stamp(now - timedelta(days=n)))
            for n in range(4)
        ]
        + [
            customer_obj(customer_id="skewed", updated_at=stamp(now + timedelta(minutes=5))),
            customer_obj(customer_id="future", updated_at=stamp(now + timedelta(minutes=6))),
        ],
    )

    result = pipeline.run("customers", path)

    assert result.counts.rejected == 1
    assert "future" not in {row["customer_id"] for row in rows(db, customers)}
    assert high_water(db) == now + timedelta(minutes=5)
