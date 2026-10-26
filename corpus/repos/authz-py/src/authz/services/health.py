"""Dependency checks for the health endpoint."""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from dataclasses import dataclass

from authz.logging import get_logger

log = get_logger(__name__)

CHECK_TIMEOUT_SECONDS = 2.0


@dataclass(frozen=True, slots=True)
class HealthReport:
    checks: dict[str, str]

    @property
    def healthy(self) -> bool:
        return all(state == "ok" for state in self.checks.values())


class HealthService:
    def __init__(self, checks: dict[str, Callable[[], Awaitable[None]]]) -> None:
        self._checks = checks

    async def _run(self, name: str, check: Callable[[], Awaitable[None]]) -> tuple[str, str]:
        try:
            await asyncio.wait_for(check(), timeout=CHECK_TIMEOUT_SECONDS)
        except TimeoutError:
            log.warning("health.check_failed", check=name, error="timeout")
            return name, "timeout"
        except Exception as error:
            # Any failure means the dependency is unusable; the type is enough for the log.
            log.warning("health.check_failed", check=name, error=type(error).__name__)
            return name, "error"
        return name, "ok"

    async def report(self) -> HealthReport:
        results = await asyncio.gather(
            *(self._run(name, check) for name, check in self._checks.items())
        )
        return HealthReport(checks=dict(results))
