from __future__ import annotations

import io
import json

import structlog

from authz.logging import REDACTED, configure_logging, get_logger, redact_secrets


def test_redacts_sensitive_keys_at_any_depth():
    event = redact_secrets(
        None,
        "info",
        {
            "event": "x",
            "password": "hunter2-hunter2",
            "refresh_token": "abc",
            "request": {"headers": {"Authorization": "Bearer abc"}, "path": "/v1/me"},
            "items": [{"smtp_password": "pw"}],
            "user_id": "u-1",
        },
    )

    assert event["password"] == REDACTED
    assert event["refresh_token"] == REDACTED
    assert event["request"]["headers"]["Authorization"] == REDACTED
    assert event["request"]["path"] == "/v1/me"
    assert event["items"][0]["smtp_password"] == REDACTED
    assert event["user_id"] == "u-1"


def test_logs_are_json_lines_without_secrets():
    stream = io.StringIO()
    configure_logging("info", stream=stream)
    try:
        get_logger("authz.test").info("user.login", email="a@example.com", password="secret-pw")
    finally:
        structlog.reset_defaults()

    line = json.loads(stream.getvalue().strip().splitlines()[-1])
    assert line["event"] == "user.login"
    assert line["level"] == "info"
    assert line["password"] == REDACTED
    assert "secret-pw" not in stream.getvalue()
