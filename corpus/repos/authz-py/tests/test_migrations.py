from __future__ import annotations

from alembic import command
from alembic.autogenerate import compare_metadata
from alembic.migration import MigrationContext
from alembic.script import ScriptDirectory
from sqlalchemy import create_engine, text

from authz.infra.db import to_driver_url
from authz.models import Base
from tests.conftest import alembic_config


def test_migrations_have_a_single_head(migrated_database):
    script = ScriptDirectory.from_config(alembic_config(migrated_database))

    assert len(script.get_heads()) == 1


def test_models_match_the_migrated_schema(migrated_database):
    engine = create_engine(to_driver_url(migrated_database))
    try:
        with engine.connect() as connection:
            context = MigrationContext.configure(connection)
            differences = compare_metadata(context, Base.metadata)
    finally:
        engine.dispose()

    assert differences == []


def test_downgrade_and_upgrade_round_trip(migrated_database):
    config = alembic_config(migrated_database)

    command.downgrade(config, "base")
    command.upgrade(config, "head")

    engine = create_engine(to_driver_url(migrated_database))
    try:
        with engine.connect() as connection:
            version = connection.execute(text("SELECT version_num FROM alembic_version")).scalar()
    finally:
        engine.dispose()
    assert version == ScriptDirectory.from_config(config).get_current_head()
