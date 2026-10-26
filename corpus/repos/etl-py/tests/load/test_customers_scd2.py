"""Customers as a type 2 dimension: one row per version, valid over [valid_from, valid_to)."""

from __future__ import annotations

import itertools
from datetime import UTC, datetime

from etl.infra.tables import customers
from etl.store import watermarks
from tests.helpers.db import rows
from tests.helpers.factories import customer_obj, write_customers


def versions(db, customer_id="C-1"):
    return rows(db, customers, order_by="valid_from", customer_id=customer_id)


def load(pipeline, tmp_path, name, *objects):
    return pipeline.run("customers", write_customers(tmp_path, objects, name=name))


def test_a_new_customer_starts_a_current_version(pipeline, db, tmp_path):
    result = load(pipeline, tmp_path, "a.jsonl", customer_obj())

    (version,) = versions(db)
    assert version["is_current"] is True
    assert version["valid_from"] == datetime(2026, 3, 1, 8, 0, tzinfo=UTC)
    assert version["valid_to"] is None
    assert version["email"] == "ada.example@example.com"
    assert result.counts.loaded == 1


def test_a_changed_attribute_closes_the_version_and_opens_a_new_one(pipeline, db, tmp_path):
    load(pipeline, tmp_path, "a.jsonl", customer_obj())
    moved = customer_obj(country="fr", phone="+33 6 12 34 56 78", updated_at="2026-03-05T10:00:00Z")

    result = load(pipeline, tmp_path, "b.jsonl", moved)

    old, new = versions(db)
    assert (old["is_current"], old["valid_to"]) == (False, datetime(2026, 3, 5, 10, tzinfo=UTC))
    assert (new["is_current"], new["valid_from"]) == (True, old["valid_to"])
    assert new["country"] == "FR"
    assert new["valid_to"] is None
    assert result.counts.loaded == 1


def test_a_newer_row_without_changes_only_moves_updated_at(pipeline, db, tmp_path):
    load(pipeline, tmp_path, "a.jsonl", customer_obj())

    load(pipeline, tmp_path, "b.jsonl", customer_obj(updated_at="2026-03-06T00:00:00Z"))

    (version,) = versions(db)
    assert version["valid_from"] == datetime(2026, 3, 1, 8, tzinfo=UTC)
    assert version["updated_at"] == datetime(2026, 3, 6, tzinfo=UTC)


def test_an_older_row_changes_nothing(pipeline, db, tmp_path):
    load(pipeline, tmp_path, "a.jsonl", customer_obj(updated_at="2026-03-05T00:00:00Z"))
    with db.begin() as connection:
        watermarks.reset(connection, "customers", to=None, now=datetime.now(UTC))

    result = load(
        pipeline, tmp_path, "b.jsonl", customer_obj(country="nl", updated_at="2026-03-04T00:00:00Z")
    )

    (version,) = versions(db)
    assert version["country"] == "DE"
    assert result.counts.loaded == 0


def test_versions_of_one_batch_collapse_to_the_latest(pipeline, db, tmp_path):
    load(
        pipeline,
        tmp_path,
        "a.jsonl",
        customer_obj(country="nl", updated_at="2026-03-03T00:00:00Z"),
        customer_obj(country="de", updated_at="2026-03-01T00:00:00Z"),
        customer_obj(customer_id="C-2", updated_at="2026-03-02T00:00:00Z"),
    )

    (version,) = versions(db)
    assert version["country"] == "NL"
    assert len(versions(db, "C-2")) == 1


def test_history_stays_contiguous_over_several_changes(pipeline, db, tmp_path):
    for day, country in enumerate(["de", "fr", "nl", "be"], start=1):
        stamp = f"2026-03-0{day}T12:00:00Z"
        load(pipeline, tmp_path, f"{day}.jsonl", customer_obj(country=country, updated_at=stamp))

    history = versions(db)
    assert [version["country"] for version in history] == ["DE", "FR", "NL", "BE"]
    assert [version["is_current"] for version in history] == [False, False, False, True]
    for earlier, later in itertools.pairwise(history):
        assert earlier["valid_to"] == later["valid_from"]
