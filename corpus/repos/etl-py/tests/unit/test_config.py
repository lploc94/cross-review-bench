from __future__ import annotations

import pytest

from etl.config import load_settings
from etl.errors import ConfigError

URL = "postgresql://etl:secret@db.internal:5432/warehouse"


@pytest.fixture(autouse=True)
def _clean_environment(monkeypatch):
    for name in ("DATABASE_URL", "REPORTING_ZONE", "MAX_REJECT_RATIO", "BATCH_SIZE", "REPORT_DIR"):
        monkeypatch.delenv(name, raising=False)


def test_settings_come_from_the_environment(monkeypatch, tmp_path):
    monkeypatch.setenv("DATABASE_URL", URL)
    monkeypatch.setenv("REPORTING_ZONE", "Europe/Berlin")
    monkeypatch.setenv("MAX_REJECT_RATIO", "0.1")
    monkeypatch.setenv("REPORT_DIR", str(tmp_path))

    settings = load_settings()

    assert settings.database_url.get_secret_value() == URL
    assert settings.reporting_tz.key == "Europe/Berlin"
    assert settings.max_reject_ratio == 0.1
    assert settings.report_dir == tmp_path
    assert settings.batch_size == 1000
    assert "secret" not in repr(settings)


def test_every_problem_is_listed_at_once(monkeypatch):
    monkeypatch.setenv("REPORTING_ZONE", "Europe/Atlantis")
    monkeypatch.setenv("MAX_REJECT_RATIO", "1.5")
    monkeypatch.setenv("BATCH_SIZE", "0")

    with pytest.raises(ConfigError) as caught:
        load_settings()

    problems = "\n".join(caught.value.problems)
    assert "DATABASE_URL: Field required" in problems
    assert "REPORTING_ZONE: unknown time zone 'Europe/Atlantis'" in problems
    assert "MAX_REJECT_RATIO" in problems
    assert "BATCH_SIZE" in problems


def test_only_postgres_urls_are_accepted(monkeypatch):
    monkeypatch.setenv("DATABASE_URL", "sqlite:///warehouse.db")

    with pytest.raises(ConfigError, match="must be a postgres"):
        load_settings()


def test_the_report_directory_must_not_be_a_file(monkeypatch, tmp_path):
    monkeypatch.setenv("DATABASE_URL", URL)
    monkeypatch.setenv("REPORT_DIR", str(tmp_path / "file"))
    (tmp_path / "file").write_text("x")

    with pytest.raises(ConfigError, match="not a directory"):
        load_settings()
