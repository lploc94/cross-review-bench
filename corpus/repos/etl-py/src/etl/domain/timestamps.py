"""Wall-clock times of a source zone to UTC instants, with explicit DST handling.

A naive local time can be:

- unambiguous: it maps to one instant;
- nonexistent: it falls in a spring-forward gap (02:30 on the night clocks jump from 02:00 to
  03:00); such a time never appeared on a clock in that zone, so it is refused;
- ambiguous: it falls in a fall-back fold (02:30 on the night clocks go from 03:00 back to
  02:00) and names two instants; the source's `AmbiguousTimePolicy` picks one or refuses it.
"""

from __future__ import annotations

from datetime import UTC, date, datetime, time, timedelta
from enum import StrEnum
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError


class AmbiguousTimePolicy(StrEnum):
    EARLIER = "earlier"  # the first occurrence (fold=0), still on the summer offset
    LATER = "later"  # the second occurrence (fold=1), on the winter offset
    REJECT = "reject"


class NonexistentTime(ValueError):
    """The local time falls in a DST gap of its zone."""


class AmbiguousTime(ValueError):
    """The local time falls in a DST fold and the policy refuses to pick an occurrence."""


def load_zone(name: str) -> ZoneInfo:
    """The IANA zone `name`; ValueError when it is not a known zone key."""
    try:
        return ZoneInfo(name)
    except (ZoneInfoNotFoundError, ValueError, OSError) as error:
        raise ValueError(f"unknown time zone {name!r}") from error


def _wall(moment: datetime, zone: ZoneInfo) -> datetime:
    """The wall-clock time of an instant in `zone`. Goes through UTC: astimezone() to the
    tzinfo a datetime already has returns it unchanged, which would hide a gap."""
    return moment.astimezone(UTC).astimezone(zone).replace(tzinfo=None)


def localize(naive: datetime, zone: ZoneInfo, policy: AmbiguousTimePolicy) -> datetime:
    """The UTC instant a wall-clock time in `zone` names.

    Raises NonexistentTime for a time inside a gap, and AmbiguousTime for a time inside a fold
    when the policy is REJECT.
    """
    if naive.tzinfo is not None:
        raise ValueError("localize expects a naive datetime")
    earlier = naive.replace(tzinfo=zone, fold=0)
    later = naive.replace(tzinfo=zone, fold=1)
    if earlier.utcoffset() == later.utcoffset():
        return earlier.astimezone(UTC)
    # The two folds disagree: the time is either in a gap or in a fold. In a gap neither
    # reading round-trips to the same wall time; in a fold both do.
    if _wall(earlier, zone) != naive or _wall(later, zone) != naive:
        raise NonexistentTime(f"{naive.isoformat()} does not exist in {zone.key}")
    if policy is AmbiguousTimePolicy.EARLIER:
        return earlier.astimezone(UTC)
    if policy is AmbiguousTimePolicy.LATER:
        return later.astimezone(UTC)
    raise AmbiguousTime(f"{naive.isoformat()} is ambiguous in {zone.key}")


def to_utc(moment: datetime, zone: ZoneInfo, policy: AmbiguousTimePolicy) -> datetime:
    """An aware datetime converted to UTC; a naive one read as wall-clock time in `zone`."""
    if moment.tzinfo is None:
        return localize(moment, zone, policy)
    return moment.astimezone(UTC)


def ensure_utc(moment: datetime) -> datetime:
    if moment.tzinfo is None:
        raise ValueError("naive datetimes are not accepted")
    return moment.astimezone(UTC)


def start_of_day(day: date, zone: ZoneInfo) -> datetime:
    """The first instant (UTC) whose wall-clock date in `zone` is `day`.

    When midnight falls in a gap, fold=0 reads it with the offset in force before the jump,
    which lands exactly on the transition, the first instant of that day. When midnight is
    ambiguous, fold=0 is its first occurrence.
    """
    return datetime.combine(day, time.min, tzinfo=zone).astimezone(UTC)


def day_bounds(first: date, last: date, zone: ZoneInfo) -> tuple[datetime, datetime]:
    """UTC instants [start, end) covering the calendar days first..last (inclusive) in `zone`."""
    if last < first:
        raise ValueError("the last day is before the first day")
    return start_of_day(first, zone), start_of_day(last + timedelta(days=1), zone)


def local_date(moment: datetime, zone: ZoneInfo) -> date:
    """The calendar date of an instant in `zone`."""
    return ensure_utc(moment).astimezone(zone).date()
