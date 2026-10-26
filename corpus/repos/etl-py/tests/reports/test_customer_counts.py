from __future__ import annotations

from datetime import date

import pytest

from etl.api.reports import customer_counts_report
from etl.errors import InvalidRequest
from tests.helpers.factories import customer_obj, write_customers


def load(pipeline, tmp_path, name, *objects):
    pipeline.run("customers", write_customers(tmp_path, objects, name=name))


def test_current_customers_are_counted_per_country(pipeline, context, tmp_path):
    load(
        pipeline,
        tmp_path,
        "a.jsonl",
        customer_obj(customer_id="1", country="de"),
        customer_obj(customer_id="2", country="de"),
        customer_obj(customer_id="3", country="fr"),
        customer_obj(customer_id="4", country=None, phone=None),
    )

    report = customer_counts_report(context)

    assert [(row.country, row.customers) for row in report.rows] == [
        ("DE", 2),
        ("FR", 1),
        (None, 1),
    ]
    assert report.total == 4
    assert report.path.name == "customer_counts_current.csv"
    assert report.path.read_text().splitlines()[-1] == "--,1"


def test_counts_at_the_end_of_a_past_day_use_the_version_valid_then(pipeline, context, tmp_path):
    load(
        pipeline, tmp_path, "a.jsonl", customer_obj(country="de", updated_at="2026-03-01T08:00:00Z")
    )
    # Moves at 00:00 Berlin time on 5 March (23:00 UTC on the 4th): still DE at the end of the 4th
    load(
        pipeline,
        tmp_path,
        "b.jsonl",
        customer_obj(country="fr", phone=None, updated_at="2026-03-04T23:00:00Z"),
    )

    def counts(day):
        return [(r.country, r.customers) for r in customer_counts_report(context, as_of=day).rows]

    assert counts(date(2026, 2, 28)) == []
    assert counts(date(2026, 3, 1)) == [("DE", 1)]
    assert counts(date(2026, 3, 4)) == [("DE", 1)]
    assert counts(date(2026, 3, 5)) == [("FR", 1)]
    assert counts(None) == [("FR", 1)]


def test_a_future_day_is_refused(context, db):
    with pytest.raises(InvalidRequest, match="future"):
        customer_counts_report(context, as_of=date(2026, 4, 2))
