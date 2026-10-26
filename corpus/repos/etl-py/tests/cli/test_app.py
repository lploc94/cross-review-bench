from __future__ import annotations

import subprocess
import sys

from typer.testing import CliRunner

from etl.cli.app import build_app
from etl.config import load_settings


def test_help_needs_no_configuration():
    def unusable():
        raise AssertionError("--help must not build the context")

    result = CliRunner().invoke(build_app(unusable), ["--help"])

    assert result.exit_code == 0
    for command in ("run", "runs", "checks", "report", "watermark"):
        assert command in result.stdout


def test_invalid_configuration_exits_with_code_3(monkeypatch):
    monkeypatch.setenv("DATABASE_URL", "mysql://nope")
    monkeypatch.setenv("REPORTING_ZONE", "Moon/Base")

    result = CliRunner().invoke(build_app(lambda: load_settings()), ["runs", "list"])  # type: ignore[arg-type, return-value]

    assert result.exit_code == 3
    assert "DATABASE_URL: must be a postgres:// or postgresql:// URL" in result.stderr
    assert "REPORTING_ZONE: unknown time zone 'Moon/Base'" in result.stderr


def test_python_dash_m_runs_the_same_command():
    completed = subprocess.run(
        [sys.executable, "-m", "etl", "--help"], capture_output=True, text=True, check=False
    )

    assert completed.returncode == 0
    assert "Load retail source exports into the warehouse." in completed.stdout
