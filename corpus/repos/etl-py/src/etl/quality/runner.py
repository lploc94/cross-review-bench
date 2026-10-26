"""Running checks after a load and deciding whether the run may commit."""

from __future__ import annotations

from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from decimal import Decimal

from sqlalchemy import Connection

from etl.logging import get_logger
from etl.quality.checks import Check, CheckHistory, Severity

log = get_logger(__name__)


@dataclass(frozen=True, slots=True)
class CheckResult:
    check_name: str
    table_name: str
    severity: Severity
    passed: bool
    observed: Decimal | None
    details: str

    @property
    def blocking(self) -> bool:
        """A failed error-level check: the run must not commit."""
        return not self.passed and self.severity is Severity.ERROR


def run_checks(
    connection: Connection, checks: Iterable[Check], history: CheckHistory
) -> list[CheckResult]:
    results = []
    for check in checks:
        outcome = check.evaluate(connection, history)
        result = CheckResult(
            check_name=check.name,
            table_name=check.table.name,
            severity=check.severity,
            passed=outcome.passed,
            observed=outcome.observed,
            details=outcome.details,
        )
        if not result.passed:
            log.warning(
                "check.failed",
                check=result.check_name,
                severity=str(result.severity),
                details=result.details,
            )
        results.append(result)
    return results


def blocking_failures(results: Sequence[CheckResult]) -> list[str]:
    return [result.check_name for result in results if result.blocking]
