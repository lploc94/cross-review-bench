"""Operations on watermarks: list them, show one, or reset one to re-read older rows."""

from __future__ import annotations

from datetime import datetime

from etl.api.context import AppContext
from etl.domain.timestamps import ensure_utc
from etl.errors import InvalidRequest
from etl.infra.locks import source_lock
from etl.logging import get_logger
from etl.pipeline.window import IncrementalWindow
from etl.schemas.views import WatermarkView
from etl.sources.registry import SourceSpec, get_source
from etl.store import watermarks
from etl.store.watermarks import Watermark

log = get_logger(__name__)


def _view(spec: SourceSpec, stored: Watermark | None) -> WatermarkView:
    if stored is None:
        return WatermarkView(
            source=spec.name, high_water=None, updated_at=None, lookback=spec.lookback, cutoff=None
        )
    return WatermarkView(
        source=spec.name,
        high_water=stored.high_water,
        updated_at=stored.updated_at,
        lookback=spec.lookback,
        cutoff=IncrementalWindow(stored.high_water, spec.lookback).cutoff,
    )


def list_watermarks(context: AppContext) -> list[WatermarkView]:
    """The watermark of every declared source, absent ones included."""
    with context.engine.connect() as connection:
        stored = {mark.source: mark for mark in watermarks.read_all(connection)}
    return [_view(context.sources[name], stored.get(name)) for name in sorted(context.sources)]


def show_watermark(context: AppContext, source: str) -> WatermarkView:
    spec = get_source(source, context.sources)
    with context.engine.connect() as connection:
        stored = watermarks.read(connection, spec.name)
    return _view(spec, stored)


def reset_watermark(context: AppContext, source: str, to: datetime | None) -> WatermarkView:
    """Remove the watermark (`to` None: the next run reads every row) or set it to `to`.

    Takes the source's run lock, so it never changes a watermark under a running load
    (RunLocked when one is running).
    """
    spec = get_source(source, context.sources)
    if to is not None:
        if to.tzinfo is None:
            raise InvalidRequest("the new watermark needs a UTC offset (2026-03-01T00:00:00Z)")
        to = ensure_utc(to)
        if to > context.clock.now():
            raise InvalidRequest("the new watermark is in the future")
    with source_lock(context.engine, spec.name), context.engine.begin() as connection:
        watermarks.reset(connection, spec.name, to=to, now=context.clock.now())
    log.info("watermark.reset", source=spec.name, high_water=to.isoformat() if to else None)
    return show_watermark(context, spec.name)
