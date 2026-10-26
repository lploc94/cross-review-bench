"""What the commands show about runs, checks and watermarks (tables and --json output)."""

from __future__ import annotations

from datetime import datetime, timedelta
from decimal import Decimal
from typing import Literal

from pydantic import BaseModel, ConfigDict

from etl.quality.checks import Severity
from etl.quality.runner import CheckResult
from etl.store.runs import RunRecord, RunStatus


class View(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")


class RunView(View):
    id: int
    source: str
    path: str
    status: RunStatus
    started_at: datetime
    finished_at: datetime | None
    rows_read: int
    rows_skipped: int
    rows_loaded: int
    rows_rejected: int
    error: str | None

    @classmethod
    def of(cls, record: RunRecord) -> RunView:
        return cls(
            id=record.id,
            source=record.source,
            path=record.path,
            status=record.status,
            started_at=record.started_at,
            finished_at=record.finished_at,
            rows_read=record.rows_read,
            rows_skipped=record.rows_skipped,
            rows_loaded=record.rows_loaded,
            rows_rejected=record.rows_rejected,
            error=record.error,
        )


class CheckResultView(View):
    check_name: str
    table_name: str
    severity: Severity
    passed: bool
    observed: Decimal | None
    details: str

    @classmethod
    def of(cls, result: CheckResult) -> CheckResultView:
        return cls(
            check_name=result.check_name,
            table_name=result.table_name,
            severity=result.severity,
            passed=result.passed,
            observed=result.observed,
            details=result.details,
        )


class RejectReasonView(View):
    reason: str
    count: int
    first_line_no: int


class RunDetail(View):
    run: RunView
    checks: list[CheckResultView]
    reject_reasons: list[RejectReasonView]


class CheckView(View):
    name: str
    table: str
    severity: Severity
    description: str
    last_passed: bool | None
    last_run_id: int | None
    last_details: str | None


class WatermarkView(View):
    source: str
    high_water: datetime | None
    updated_at: datetime | None
    lookback: timedelta
    # Rows with updated_at at or before this instant are skipped by the next run.
    cutoff: datetime | None


class SourceView(View):
    name: str
    dataset: str
    file_format: Literal["csv", "jsonl"]
    encoding: str
    delimiter: str | None
    decimal_separator: str | None
    zone: str
    ambiguous_times: str
    timestamp_formats: list[str]
    lookback: timedelta
    required_columns: list[str]
    optional_columns: list[str]
    description: str


class SourceStatusView(View):
    source: str
    # A run holds the source's lock right now.
    running: bool
    high_water: datetime | None
    last_run_id: int | None
    last_status: RunStatus | None
    last_started_at: datetime | None
    last_succeeded_run_id: int | None
    last_succeeded_at: datetime | None


class RejectView(View):
    """A rejected row without its values: those may be personal data."""

    line_no: int
    column: str | None
    reason: str


class PruneView(View):
    before: datetime
    source: str | None
    deleted: int


class DatabaseView(View):
    server_version: str
    current_revision: str | None
    head_revision: str | None
    up_to_date: bool


class SettingsView(View):
    """The effective configuration; the database password is masked."""

    database_url: str
    database_pool_size: int
    log_level: str
    report_dir: str
    reporting_zone: str
    max_reject_ratio: float
    batch_size: int
    max_future_skew_seconds: int
