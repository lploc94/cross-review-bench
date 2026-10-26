"""The per-source run lock and the run records around it."""

from __future__ import annotations

import pytest

from etl.errors import RunLocked, SchemaMismatch
from etl.infra.locks import LOCK_NAMESPACE, is_locked, lock_key
from etl.infra.tables import runs
from etl.store import runs as run_store
from tests.helpers.db import HeldLock, count, lock_is_free, rows
from tests.helpers.factories import product_row, write_products
from tests.helpers.files import write_text


def test_lock_keys_are_stable_signed_32_bit_integers():
    assert lock_key("orders") == lock_key("orders")
    assert lock_key("orders") != lock_key("products")
    for source in ("orders", "customers", "products", "x" * 300):
        assert -(2**31) <= lock_key(source) < 2**31
    assert lock_key("orders") == -449_839_634  # CRC-32 of "orders" (3845127662) as int32
    assert LOCK_NAMESPACE == 4_543_564


def test_a_second_run_of_the_same_source_is_refused(pipeline, db, tmp_path):
    path = write_products(tmp_path, [product_row()])

    with HeldLock(db, "products"), pytest.raises(RunLocked):
        pipeline.run("products", path)

    assert count(db, runs) == 0


def test_runs_of_other_sources_are_not_blocked(pipeline, db, tmp_path):
    with HeldLock(db, "orders"):
        result = pipeline.run("products", write_products(tmp_path, [product_row()]))

    assert result.counts.loaded == 1


def test_the_lock_is_released_after_success_and_after_failure(pipeline, db, tmp_path):
    pipeline.run("products", write_products(tmp_path, [product_row()]))
    assert lock_is_free(db, "products")

    with pytest.raises(SchemaMismatch):
        pipeline.run("products", write_text(tmp_path / "bad.csv", "sku,name\nA,B\n"))
    assert lock_is_free(db, "products")


def test_runs_left_running_by_a_dead_process_are_closed_by_the_next_run(
    pipeline, db, tmp_path, clock
):
    with db.begin() as connection:
        dead = run_store.start(
            connection, source="products", path="/exports/p.csv", started_at=clock.now()
        )

    result = pipeline.run("products", write_products(tmp_path, [product_row()]))

    assert result.abandoned_runs == [dead]
    (closed,) = rows(db, runs, id=dead)
    assert closed["status"] == "failed"
    assert closed["error"] == run_store.ABANDONED
    assert closed["finished_at"] == clock.now()


def test_a_held_lock_is_seen_without_taking_it(db):
    with db.connect() as connection:
        assert not is_locked(connection, "orders")
        with HeldLock(db, "orders"):
            assert is_locked(connection, "orders")
            assert not is_locked(connection, "customers")
        assert not is_locked(connection, "orders")
    assert lock_is_free(db, "orders")
