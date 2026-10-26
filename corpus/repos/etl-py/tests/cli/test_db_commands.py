from __future__ import annotations

import json

from alembic import command
from alembic.script import ScriptDirectory
from pydantic import SecretStr
from typer.testing import CliRunner

from etl.api.context import AppContext
from etl.cli.app import build_app
from etl.config import Settings
from tests.helpers.db import ROOT, alembic_config

CONFIG = str(ROOT / "alembic.ini")


def test_db_check_on_a_current_schema(cli, migrated_database):
    head = ScriptDirectory.from_config(alembic_config(migrated_database)).get_current_head()

    result = cli("db", "check", "--config", CONFIG, "--json")

    assert result.exit_code == 0, result.output
    view = json.loads(result.stdout)
    assert view["current_revision"] == view["head_revision"] == head
    assert view["up_to_date"] is True
    assert view["server_version"]


def test_db_check_and_upgrade_on_a_schema_behind(cli, db, migrated_database):
    config = alembic_config(migrated_database)
    command.downgrade(config, "-1")
    try:
        behind = cli("db", "check", "--config", CONFIG)
        upgraded = cli("db", "upgrade", "--config", CONFIG)
        again = cli("db", "check", "--config", CONFIG)
    finally:
        command.upgrade(config, "head")

    assert behind.exit_code == 16
    assert "NOT up to date" in behind.stdout
    assert "run `etl db upgrade`" in behind.stderr
    assert upgraded.exit_code == 0, upgraded.output
    assert "(up to date)" in upgraded.stdout
    assert again.exit_code == 0


def test_db_check_needs_the_alembic_configuration(cli, tmp_path):
    result = cli("db", "check", "--config", str(tmp_path / "alembic.ini"))

    assert result.exit_code == 2
    assert "no Alembic configuration" in result.stderr


def test_settings_show_the_effective_values_without_the_password(db, clock, tmp_path):
    settings = Settings.model_validate(
        {
            "database_url": SecretStr("postgres://etl:s3cret-pw@db.internal:5432/warehouse"),
            "reporting_zone": "Europe/Berlin",
            "report_dir": tmp_path,
        }
    )
    context = AppContext(settings=settings, engine=db, clock=clock, owns_engine=False)

    result = CliRunner().invoke(build_app(lambda: context), ["settings"])

    assert result.exit_code == 0, result.output
    assert "postgres://etl:***@db.internal:5432/warehouse" in result.stdout
    assert "s3cret-pw" not in result.stdout
    assert "REPORTING_ZONE" in result.stdout
    assert "Europe/Berlin" in result.stdout


def test_settings_as_json(cli):
    view = json.loads(cli("settings", "--json").stdout)

    assert view["max_reject_ratio"] == 0.25
    assert view["batch_size"] == 2
