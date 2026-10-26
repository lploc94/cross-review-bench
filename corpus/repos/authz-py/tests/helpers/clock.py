"""A clock the tests move by hand."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

DEFAULT_START = datetime(2026, 3, 2, 9, 0, 0, tzinfo=UTC)


class FrozenClock:
    """Implements authz.infra.clock.Clock; time only changes when a test says so."""

    def __init__(self, start: datetime = DEFAULT_START) -> None:
        self._now = start

    def now(self) -> datetime:
        return self._now

    def advance(self, **delta: float) -> datetime:
        self._now += timedelta(**delta)
        return self._now

    def set(self, moment: datetime) -> None:
        if moment.tzinfo is None:
            raise ValueError("FrozenClock needs an aware datetime")
        self._now = moment
