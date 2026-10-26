"""Everything an operation needs: settings, database engine, clock and the declarations."""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any

from sqlalchemy import Engine

from etl.config import Settings, load_settings
from etl.infra.clock import Clock, SystemClock
from etl.infra.db import create_db_engine
from etl.logging import configure_logging
from etl.pipeline.datasets import DATASETS, DatasetBinding
from etl.pipeline.runner import Pipeline
from etl.quality.checks import Check
from etl.quality.registry import CHECKS
from etl.sources.registry import SOURCES, Dataset, SourceSpec


@dataclass(slots=True)
class AppContext:
    settings: Settings
    engine: Engine
    clock: Clock
    sources: Mapping[str, SourceSpec] = field(default_factory=lambda: SOURCES)
    datasets: Mapping[Dataset, DatasetBinding[Any]] = field(default_factory=lambda: DATASETS)
    checks: Sequence[Check] = CHECKS
    # Whether close() disposes of the engine (False when the caller shares its engine).
    owns_engine: bool = True

    def pipeline(self) -> Pipeline:
        return Pipeline(
            self.engine,
            self.settings,
            self.clock,
            sources=self.sources,
            datasets=self.datasets,
            checks=self.checks,
        )

    def close(self) -> None:
        if self.owns_engine:
            self.engine.dispose()


def build_context(settings: Settings | None = None, clock: Clock | None = None) -> AppContext:
    """The context of a process: settings from the environment (ConfigError when invalid),
    JSON logging on standard error, and a pooled engine."""
    resolved = settings if settings is not None else load_settings()
    configure_logging(resolved.log_level)
    engine = create_db_engine(
        resolved.database_url.get_secret_value(), pool_size=resolved.database_pool_size
    )
    return AppContext(settings=resolved, engine=engine, clock=clock or SystemClock())
