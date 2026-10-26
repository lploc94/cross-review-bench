from __future__ import annotations

import io
import json

import pytest

from etl.logging import REDACTED, configure_logging, get_logger, redact


@pytest.fixture
def captured():
    stream = io.StringIO()
    configure_logging("info", stream=stream)
    try:
        yield stream
    finally:
        configure_logging("debug")


def test_personal_data_and_row_contents_are_redacted_at_any_depth():
    event = redact(
        None,
        "info",
        {
            "event": "x",
            "email": "ada@example.com",
            "customer": {"Full_Name": "Ada", "phone": "+49301234567", "country": "DE"},
            "payload": {"anything": "at all"},
            "items": [{"billing_email": "b@example.com", "line_no": 3}],
            "database_url": "postgresql://u:p@h/db",
            "run_id": 7,
        },
    )

    assert event["email"] == REDACTED
    assert event["customer"] == {"Full_Name": REDACTED, "phone": REDACTED, "country": "DE"}
    assert event["payload"] == REDACTED
    assert event["items"] == [{"billing_email": REDACTED, "line_no": 3}]
    assert event["database_url"] == REDACTED
    assert event["run_id"] == 7


def test_log_lines_are_json_objects(captured):
    get_logger("etl.test").info("run.started", run_id=3, email="ada@example.com")

    line = json.loads(captured.getvalue().strip())
    assert line["event"] == "run.started"
    assert line["run_id"] == 3
    assert line["email"] == REDACTED
    assert line["level"] == "info"
    assert line["timestamp"].endswith("Z")


def test_levels_below_the_configured_one_are_dropped(captured):
    log = get_logger("etl.test")
    log.debug("noise")
    log.warning("signal")

    events = [json.loads(line)["event"] for line in captured.getvalue().splitlines()]
    assert events == ["signal"]
