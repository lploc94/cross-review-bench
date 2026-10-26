"""The incremental window of a run: which rows it takes, and where the watermark goes next."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

EARLIEST = datetime.min.replace(tzinfo=UTC)


@dataclass(frozen=True, slots=True)
class IncrementalWindow:
    """Rows are taken when `updated_at > high_water - lookback`.

    The lookback re-reads a stretch before the watermark on every run, so rows that reach the
    export late (with an `updated_at` a little in the past) are still loaded. Re-read rows the
    warehouse already holds are harmless: the upsert keeps the stored row unless the incoming
    one is strictly newer.
    """

    high_water: datetime | None
    lookback: timedelta

    @property
    def cutoff(self) -> datetime | None:
        """Rows at or before this instant are skipped; None takes every row. A watermark
        within the lookback of the earliest instant gives the earliest instant."""
        if self.high_water is None:
            return None
        try:
            return self.high_water - self.lookback
        except OverflowError:
            return EARLIEST

    def admits(self, updated_at: datetime) -> bool:
        cutoff = self.cutoff
        return cutoff is None or updated_at > cutoff

    def advance(self, newest: datetime | None) -> datetime | None:
        """The next watermark after loading rows up to `newest`, or None to keep the current
        one (nothing loaded, or nothing newer than it)."""
        if newest is None:
            return None
        if self.high_water is None or newest > self.high_water:
            return newest
        return None
