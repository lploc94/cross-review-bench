"""The effective configuration, for operators checking what a process will use."""

from __future__ import annotations

from etl.api.context import AppContext
from etl.infra.db import mask_url
from etl.schemas.views import SettingsView


def show_settings(context: AppContext) -> SettingsView:
    settings = context.settings
    return SettingsView(
        database_url=mask_url(settings.database_url.get_secret_value()),
        database_pool_size=settings.database_pool_size,
        log_level=settings.log_level,
        report_dir=str(settings.report_dir),
        reporting_zone=settings.reporting_zone,
        max_reject_ratio=settings.max_reject_ratio,
        batch_size=settings.batch_size,
        max_future_skew_seconds=settings.max_future_skew_seconds,
    )
