"""Operations on the database itself: is it reachable and is its schema current."""

from __future__ import annotations

from pathlib import Path

from etl.api.context import AppContext
from etl.errors import SchemaNotCurrent
from etl.infra import migrations
from etl.infra.db import server_version
from etl.logging import get_logger
from etl.schemas.views import DatabaseView

log = get_logger(__name__)


def check_database(
    context: AppContext, config_path: Path = migrations.DEFAULT_CONFIG
) -> DatabaseView:
    """The server version and the schema revision against the migrations' head."""
    config = migrations.load_config(config_path, context.settings.database_url.get_secret_value())
    current = migrations.current_revision(context.engine)
    head = migrations.head_revision(config)
    return DatabaseView(
        server_version=server_version(context.engine),
        current_revision=current,
        head_revision=head,
        up_to_date=current == head,
    )


def require_current_schema(view: DatabaseView) -> None:
    if not view.up_to_date:
        raise SchemaNotCurrent(view.current_revision, view.head_revision)


def upgrade_database(
    context: AppContext, config_path: Path = migrations.DEFAULT_CONFIG
) -> DatabaseView:
    """Apply the migrations the database lacks."""
    before = check_database(context, config_path)
    if before.up_to_date:
        return before
    config = migrations.load_config(config_path, context.settings.database_url.get_secret_value())
    migrations.upgrade(config)
    after = check_database(context, config_path)
    log.info(
        "database.upgraded",
        from_revision=before.current_revision,
        to_revision=after.current_revision,
    )
    return after
