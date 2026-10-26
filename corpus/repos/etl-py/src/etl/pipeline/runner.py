"""One run of one source file, from the run lock to the committed load.

1. Take the source's run lock (RunLocked when another run holds it); runs left `running` by a
   dead process are marked failed.
2. Record the run as `running` (committed on its own, so failures stay visible).
3. In one transaction: read the watermark; stream the file through the normaliser into a
   temporary staging table, keeping rows inside the incremental window; reject what is
   invalid; fail when the reject ratio is too high; merge the deduplicated batch into the
   warehouse (newer wins); run the quality checks; advance the watermark; record the checks
   and the finished run; commit.
4. On any failure the warehouse writes roll back, and the run is recorded as failed with its
   counts, check results and error.
"""

from __future__ import annotations

import itertools
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

from sqlalchemy import Engine, MetaData, func, select

from etl.config import Settings
from etl.domain.records import RejectedGroups
from etl.errors import (
    EtlError,
    QualityCheckFailed,
    SourceFileNotFound,
    TooManyRejects,
    describe_error,
)
from etl.infra.clock import Clock
from etl.infra.locks import source_lock
from etl.load.base import LoadContext
from etl.logging import get_logger
from etl.pipeline.datasets import DATASETS, DatasetBinding
from etl.pipeline.extract import ExtractCounts, extract
from etl.pipeline.sink import RejectSink
from etl.pipeline.window import IncrementalWindow
from etl.quality.checks import Check
from etl.quality.registry import CHECKS, checks_for
from etl.quality.runner import CheckResult, blocking_failures, run_checks
from etl.sources.readers import open_reader
from etl.sources.registry import SOURCES, Dataset, SourceSpec, get_source
from etl.store import check_results, runs, watermarks
from etl.store.check_results import SucceededRunHistory
from etl.store.runs import RunCounts, RunStatus

log = get_logger(__name__)


@dataclass(frozen=True, slots=True)
class RunResult:
    run_id: int
    source: str
    counts: RunCounts
    high_water: datetime | None
    checks: list[CheckResult]
    abandoned_runs: list[int]


@dataclass(slots=True)
class _Attempt:
    """What a run has done so far; recorded whether it succeeds or fails."""

    run_id: int
    sink: RejectSink
    extracted: ExtractCounts = field(default_factory=ExtractCounts)
    # Versions (or keys) with a rejected row; the loader refuses the rest of their rows.
    rejected: RejectedGroups = field(default_factory=RejectedGroups)
    loaded: int = 0
    checks: list[CheckResult] = field(default_factory=list)

    def counts(self, *, loaded: int) -> RunCounts:
        return RunCounts(
            read=self.extracted.read,
            skipped=self.extracted.skipped,
            loaded=loaded,
            rejected=self.extracted.rejected,
        )


class Pipeline:
    def __init__(
        self,
        engine: Engine,
        settings: Settings,
        clock: Clock,
        *,
        sources: Mapping[str, SourceSpec] = SOURCES,
        datasets: Mapping[Dataset, DatasetBinding[Any]] = DATASETS,
        checks: Sequence[Check] = CHECKS,
    ) -> None:
        self._engine = engine
        self._settings = settings
        self._clock = clock
        self._sources = sources
        self._datasets = datasets
        self._checks = checks

    def run(self, source: str, path: Path) -> RunResult:
        """Load `path` as a file of `source`. Raises an EtlError (with `run_id` set once the
        run was recorded) when the run fails."""
        spec = get_source(source, self._sources)
        binding = self._datasets[spec.dataset]
        if not path.is_file():
            raise SourceFileNotFound(str(path))
        with source_lock(self._engine, spec.name):
            started_at = self._clock.now()
            with self._engine.begin() as connection:
                abandoned = runs.abandon_running(connection, source=spec.name, now=started_at)
                run_id = runs.start(
                    connection, source=spec.name, path=str(path), started_at=started_at
                )
            if abandoned:
                log.warning("run.abandoned_runs_closed", source=spec.name, run_ids=abandoned)
            log.info("run.started", source=spec.name, run_id=run_id, path=str(path))
            attempt = _Attempt(
                run_id=run_id,
                sink=RejectSink(
                    self._engine,
                    run_id=run_id,
                    source=spec.name,
                    clock=self._clock,
                    flush_every=self._settings.batch_size,
                ),
            )
            try:
                high_water = self._load(spec, binding, path, attempt)
            except BaseException as error:
                self._record_failure(spec, attempt, error)
                if isinstance(error, EtlError):
                    error.run_id = run_id
                raise
        counts = attempt.counts(loaded=attempt.loaded)
        log.info(
            "run.succeeded",
            source=spec.name,
            run_id=run_id,
            rows_read=counts.read,
            rows_skipped=counts.skipped,
            rows_loaded=counts.loaded,
            rows_rejected=counts.rejected,
        )
        return RunResult(
            run_id=run_id,
            source=spec.name,
            counts=counts,
            high_water=high_water,
            checks=attempt.checks,
            abandoned_runs=abandoned,
        )

    def _load(
        self,
        spec: SourceSpec,
        binding: DatasetBinding[Any],
        path: Path,
        attempt: _Attempt,
    ) -> datetime | None:
        """The transactional part of a run. Returns the watermark after the run."""
        loader = binding.loader
        now = self._clock.now()
        not_after = now + timedelta(seconds=self._settings.max_future_skew_seconds)
        counts = attempt.extracted
        with self._engine.connect() as connection, connection.begin():
            previous = watermarks.read(connection, spec.name)
            window = IncrementalWindow(
                previous.high_water if previous is not None else None, spec.lookback
            )
            stage = loader.stage_table(MetaData())
            stage.create(connection)

            with open_reader(spec, path) as items:
                records = extract(
                    items,
                    spec=spec,
                    normalise=binding.normalise,
                    window=window,
                    not_after=not_after,
                    sink=attempt.sink,
                    counts=counts,
                    version_of=binding.version_of,
                    key_of=binding.key_of,
                    refuse_malformed=binding.refuse_malformed,
                    rejected=attempt.rejected,
                )
                for batch in itertools.batched(records, self._settings.batch_size, strict=False):
                    connection.execute(stage.insert(), [loader.stage_row(r) for r in batch])

            for staged in loader.remove_inconsistent(connection, stage, attempt.rejected):
                attempt.sink.add(staged.line_no, staged.reason, staged.column, staged.payload)
                counts.rejected += 1
                counts.staged -= 1
            attempt.sink.flush()
            if counts.reject_ratio > self._settings.max_reject_ratio:
                raise TooManyRejects(
                    spec.name,
                    rejected=counts.rejected,
                    read=counts.read,
                    max_ratio=self._settings.max_reject_ratio,
                )

            stats = loader.merge(connection, stage, LoadContext(attempt.run_id, now))
            attempt.loaded = stats.written
            newest = connection.execute(select(func.max(stage.c.updated_at))).scalar_one()

            attempt.checks = run_checks(
                connection,
                checks_for(loader.target_tables, self._checks),
                SucceededRunHistory(connection),
            )
            blocking = blocking_failures(attempt.checks)
            if blocking:
                raise QualityCheckFailed(blocking)

            high_water = window.advance(newest)
            if high_water is not None:
                watermarks.advance(
                    connection, spec.name, expected=window.high_water, new=high_water, now=now
                )

            finished_at = self._clock.now()
            check_results.save(
                connection, run_id=attempt.run_id, results=attempt.checks, checked_at=finished_at
            )
            runs.finish(
                connection,
                attempt.run_id,
                status=RunStatus.SUCCEEDED,
                finished_at=finished_at,
                counts=attempt.counts(loaded=stats.written),
            )
        return high_water if high_water is not None else window.high_water

    def _record_failure(self, spec: SourceSpec, attempt: _Attempt, error: BaseException) -> None:
        """Record the failed run. Problems doing so are logged, never raised over `error`."""
        message = describe_error(error)
        try:
            attempt.sink.flush()
        except Exception as flush_error:
            log.error(
                "run.rejects_not_recorded",
                run_id=attempt.run_id,
                error=describe_error(flush_error),
            )
        try:
            with self._engine.begin() as connection:
                check_results.save(
                    connection,
                    run_id=attempt.run_id,
                    results=attempt.checks,
                    checked_at=self._clock.now(),
                )
                runs.finish(
                    connection,
                    attempt.run_id,
                    status=RunStatus.FAILED,
                    finished_at=self._clock.now(),
                    counts=attempt.counts(loaded=0),
                    error=message,
                )
        except Exception as record_error:
            log.error(
                "run.failure_not_recorded",
                run_id=attempt.run_id,
                error=describe_error(record_error),
            )
        log.error(
            "run.failed",
            source=spec.name,
            run_id=attempt.run_id,
            error=message,
            error_type=type(error).__name__,
        )
