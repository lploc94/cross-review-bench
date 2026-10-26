"""Time source. Everything that compares or stores times asks a Clock, never datetime.now()."""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Protocol


class Clock(Protocol):
    def now(self) -> datetime:
        """The current time, timezone-aware in UTC."""
        ...


class SystemClock:
    def now(self) -> datetime:
        return datetime.now(UTC)


def epoch_seconds(moment: datetime) -> int:
    return int(moment.timestamp())


def ensure_utc(moment: datetime) -> datetime:
    if moment.tzinfo is None:
        raise ValueError("naive datetimes are not accepted")
    return moment.astimezone(UTC)
