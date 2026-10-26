"""Operations on sources: what is declared, and where each source stands."""

from __future__ import annotations

from etl.api.context import AppContext
from etl.infra.locks import is_locked
from etl.schemas.views import SourceStatusView, SourceView
from etl.sources.registry import CsvFormat, SourceSpec, get_source
from etl.store import runs, watermarks


def _view(spec: SourceSpec) -> SourceView:
    file_format = spec.file_format
    csv = file_format if isinstance(file_format, CsvFormat) else None
    return SourceView(
        name=spec.name,
        dataset=str(spec.dataset),
        file_format="csv" if csv is not None else "jsonl",
        encoding=file_format.encoding,
        delimiter=csv.delimiter if csv is not None else None,
        decimal_separator=csv.decimal_separator if csv is not None else None,
        zone=spec.zone,
        ambiguous_times=str(spec.ambiguous_times),
        timestamp_formats=list(spec.timestamp_formats),
        lookback=spec.lookback,
        required_columns=list(spec.required_columns),
        optional_columns=list(spec.optional_columns),
        description=spec.description,
    )


def list_sources(context: AppContext) -> list[SourceView]:
    return [_view(spec) for spec in sorted(context.sources.values(), key=lambda s: s.name)]


def show_source(context: AppContext, source: str) -> SourceView:
    return _view(get_source(source, context.sources))


def source_status(context: AppContext, source: str | None = None) -> list[SourceStatusView]:
    """Per source: whether a run is in progress, the watermark, the latest run and the latest
    successful one."""
    if source is not None:
        names = [get_source(source, context.sources).name]
    else:
        names = sorted(context.sources)
    views = []
    with context.engine.connect() as connection:
        for name in names:
            mark = watermarks.read(connection, name)
            latest = runs.latest(connection, name)
            succeeded = runs.last_succeeded(connection, name)
            views.append(
                SourceStatusView(
                    source=name,
                    running=is_locked(connection, name),
                    high_water=mark.high_water if mark is not None else None,
                    last_run_id=latest.id if latest is not None else None,
                    last_status=latest.status if latest is not None else None,
                    last_started_at=latest.started_at if latest is not None else None,
                    last_succeeded_run_id=succeeded.id if succeeded is not None else None,
                    last_succeeded_at=succeeded.finished_at if succeeded is not None else None,
                )
            )
    return views
