from __future__ import annotations

from alembic import command
from alembic.autogenerate import compare_metadata
from alembic.migration import MigrationContext
from alembic.script import ScriptDirectory
from sqlalchemy import create_engine, text

from etl.infra.db import to_driver_url
from etl.infra.tables import ETL_SCHEMA, WAREHOUSE_SCHEMA, metadata
from tests.helpers.db import alembic_config


def only_service_schemas(name, type_, parent_names):
    return name in {ETL_SCHEMA, WAREHOUSE_SCHEMA} if type_ == "schema" else True


def test_migrations_have_a_single_head(migrated_database):
    script = ScriptDirectory.from_config(alembic_config(migrated_database))

    assert len(script.get_heads()) == 1


def test_table_definitions_match_the_migrated_schema(migrated_database):
    engine = create_engine(to_driver_url(migrated_database))
    try:
        with engine.connect() as connection:
            context = MigrationContext.configure(
                connection,
                opts={"include_schemas": True, "include_name": only_service_schemas},
            )
            differences = compare_metadata(context, metadata)
    finally:
        engine.dispose()

    assert differences == []


def test_downgrade_and_upgrade_round_trip(migrated_database, engine):
    engine.dispose()  # no pooled session may hold locks on the tables being dropped
    config = alembic_config(migrated_database)

    command.downgrade(config, "base")
    command.upgrade(config, "head")

    with engine.connect() as connection:
        version = connection.execute(text("SELECT version_num FROM alembic_version")).scalar()
        schemas = set(
            connection.execute(
                text("SELECT nspname FROM pg_namespace WHERE nspname IN ('etl', 'warehouse')")
            ).scalars()
        )
    assert version == ScriptDirectory.from_config(config).get_current_head()
    assert schemas == {"etl", "warehouse"}
