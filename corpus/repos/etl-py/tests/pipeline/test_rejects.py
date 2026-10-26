"""Rejected rows: recorded with their reason, and failing the run above the allowed ratio."""

from __future__ import annotations

import pytest

from etl.errors import TooManyRejects
from etl.infra.tables import customers, rejects, runs
from etl.pipeline.sink import safe_payload
from etl.store import rejects as reject_store
from tests.helpers.db import count, rows
from tests.helpers.factories import customer_obj, write_customers


def test_invalid_rows_are_recorded_and_the_rest_is_loaded(pipeline, db, tmp_path):
    objects = [customer_obj(customer_id=f"C-{n}") for n in range(8)]
    objects[2] = customer_obj(customer_id="C-2", email="not-an-address")
    path = write_customers(tmp_path, objects, raw_lines={5: "{oops"})

    result = pipeline.run("customers", path)

    assert (result.counts.read, result.counts.rejected, result.counts.loaded) == (9, 2, 7)
    stored = rows(db, rejects, order_by="line_no")
    assert [(item["line_no"], item["column_name"]) for item in stored] == [(3, "email"), (6, None)]
    assert stored[0]["reason"] == "email: not an email address"
    assert stored[0]["payload"]["customer_id"] == "C-2"
    assert stored[1]["reason"].startswith("invalid JSON")
    assert stored[1]["payload"] == "{oops"
    assert {item["run_id"] for item in stored} == {result.run_id}


def test_a_reject_ratio_at_the_threshold_is_allowed(pipeline, db, tmp_path):
    # settings: max_reject_ratio 0.25
    objects = [customer_obj(customer_id=f"C-{n}") for n in range(3)]
    objects.append(customer_obj(customer_id="bad", country="Narnia"))

    result = pipeline.run("customers", write_customers(tmp_path, objects))

    assert (result.counts.rejected, result.counts.read) == (1, 4)


def test_too_many_rejects_fail_the_run_but_keep_the_rejects(pipeline, db, tmp_path):
    objects = [customer_obj(customer_id=f"C-{n}") for n in range(3)]
    objects += [customer_obj(customer_id=f"bad-{n}", email="x") for n in range(2)]

    with pytest.raises(TooManyRejects) as caught:
        pipeline.run("customers", write_customers(tmp_path, objects))

    assert (caught.value.rejected, caught.value.read) == (2, 5)
    assert count(db, customers) == 0
    (run,) = rows(db, runs)
    assert (run["status"], run["rows_read"], run["rows_rejected"]) == ("failed", 5, 2)
    assert run["rows_loaded"] == 0
    assert "2 of 5 rows rejected" in run["error"]
    assert count(db, rejects, run_id=run["id"]) == 2


def test_reject_reasons_are_grouped_for_a_run(pipeline, db, tmp_path):
    objects = [customer_obj(customer_id=f"C-{n}") for n in range(12)]
    objects[1] = customer_obj(customer_id="x1", email="bad")
    objects[4] = customer_obj(customer_id="x2", email="bad")
    objects[7] = customer_obj(customer_id="", email="bad")

    result = pipeline.run("customers", write_customers(tmp_path, objects))

    with db.connect() as connection:
        reasons = reject_store.reasons(connection, result.run_id)
    assert [(r.reason, r.count, r.first_line_no) for r in reasons] == [
        ("email: not an email address", 2, 2),
        ("customer_id is missing", 1, 8),
    ]


def test_nul_characters_never_reach_the_database(pipeline, db, tmp_path):
    objects = [customer_obj(customer_id=f"C-{n}") for n in range(4)]
    objects.append(customer_obj(customer_id="C-\x00"))

    result = pipeline.run("customers", write_customers(tmp_path, objects))

    (stored,) = rows(db, rejects)
    assert stored["reason"] == "customer_id contains a NUL character"
    assert stored["payload"]["customer_id"] == "C-\ufffd"
    assert result.counts.loaded == 4


def test_numbers_too_large_for_a_float_are_rejected_and_stored_as_text(pipeline, db, tmp_path):
    objects = [customer_obj(customer_id=f"C-{n}") for n in range(4)]
    overflowing = (
        '{"customer_id": "C-9", "updated_at": "2026-03-01T08:00:00Z", '
        '"full_name": -1e400, "marketing_opt_in": 1e400}'
    )
    path = write_customers(tmp_path, objects, raw_lines={2: overflowing})

    result = pipeline.run("customers", path)

    (stored,) = rows(db, rejects)
    assert (stored["line_no"], stored["column_name"]) == (3, "full_name")
    assert stored["payload"]["full_name"] == "-inf"
    assert stored["payload"]["marketing_opt_in"] == "inf"
    assert (result.counts.read, result.counts.rejected, result.counts.loaded) == (5, 1, 4)


def test_lone_surrogates_reject_the_row_and_are_stored_replaced(pipeline, db, tmp_path):
    objects = [customer_obj(customer_id=f"C-{n}") for n in range(4)]
    objects.append({**customer_obj(customer_id="C-9", full_name="A\ud800B"), "note\udc00": "x"})

    result = pipeline.run("customers", write_customers(tmp_path, objects))

    (stored,) = rows(db, rejects)
    assert (stored["reason"], stored["column_name"]) == ("full_name is not valid text", "full_name")
    assert stored["payload"]["full_name"] == "A\ufffdB"
    assert stored["payload"]["note\ufffd"] == "x"
    assert (result.counts.rejected, result.counts.loaded) == (1, 4)


def test_reject_payloads_only_hold_values_jsonb_accepts():
    payload = {"a\ud800": [float("inf"), float("-inf"), float("nan"), 1.5, "x\x00\udfff", None]}

    assert safe_payload(payload) == {"a\ufffd": ["inf", "-inf", "nan", 1.5, "x\ufffd\ufffd", None]}


def test_keys_that_become_equal_once_made_storable_are_all_kept():
    # Built from pairs: these keys are distinct only until they are made storable.
    nested = dict(zip(["c\x00", "c\ufffd"], [4, 5], strict=True))
    payload = {**dict(zip(["a\ud800", "a\udc00", "a\ufffd"], [1, 2, 3], strict=True)), "b": nested}

    assert safe_payload(payload) == {
        "a\ufffd": 3,
        "a\ufffd#2": 1,
        "a\ufffd#3": 2,
        "b": {"c\ufffd": 5, "c\ufffd#2": 4},
    }


@pytest.mark.parametrize("replaced_first", [True, False])
def test_keys_already_present_keep_their_names(replaced_first):
    pairs = [("a\ud800", 1), ("a\ufffd", 2), ("a\ufffd#2", 3)]
    if not replaced_first:
        pairs.reverse()

    assert safe_payload(dict(pairs)) == {"a\ufffd": 2, "a\ufffd#2": 3, "a\ufffd#3": 1}
