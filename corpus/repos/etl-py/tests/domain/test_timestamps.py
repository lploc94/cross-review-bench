from __future__ import annotations

from datetime import UTC, date, datetime

import pytest

from etl.domain.timestamps import (
    AmbiguousTime,
    AmbiguousTimePolicy,
    NonexistentTime,
    day_bounds,
    load_zone,
    localize,
    start_of_day,
    to_utc,
)

BERLIN = load_zone("Europe/Berlin")
EARLIER = AmbiguousTimePolicy.EARLIER
LATER = AmbiguousTimePolicy.LATER
REJECT = AmbiguousTimePolicy.REJECT


def utc(
    year: int, month: int, day: int, hour: int = 0, minute: int = 0, second: int = 0
) -> datetime:
    return datetime(year, month, day, hour, minute, second, tzinfo=UTC)


def test_plain_times_use_the_offset_in_force():
    assert localize(datetime(2026, 1, 15, 12, 0), BERLIN, REJECT) == utc(2026, 1, 15, 11, 0)
    assert localize(datetime(2026, 7, 15, 12, 0), BERLIN, REJECT) == utc(2026, 7, 15, 10, 0)


@pytest.mark.parametrize("wall", [datetime(2026, 3, 29, 2, 0), datetime(2026, 3, 29, 2, 30)])
def test_times_in_the_spring_forward_gap_do_not_exist(wall):
    for policy in AmbiguousTimePolicy:
        with pytest.raises(NonexistentTime):
            localize(wall, BERLIN, policy)


def test_the_edges_of_the_gap_exist():
    assert localize(datetime(2026, 3, 29, 1, 59, 59), BERLIN, REJECT) == utc(2026, 3, 29, 0, 59, 59)
    assert localize(datetime(2026, 3, 29, 3, 0), BERLIN, REJECT) == utc(2026, 3, 29, 1, 0)


def test_times_in_the_fall_back_fold_follow_the_policy():
    wall = datetime(2026, 10, 25, 2, 30)

    assert localize(wall, BERLIN, EARLIER) == utc(2026, 10, 25, 0, 30)
    assert localize(wall, BERLIN, LATER) == utc(2026, 10, 25, 1, 30)
    with pytest.raises(AmbiguousTime):
        localize(wall, BERLIN, REJECT)


def test_the_edges_of_the_fold_are_unambiguous():
    assert localize(datetime(2026, 10, 25, 1, 59), BERLIN, REJECT) == utc(2026, 10, 24, 23, 59)
    assert localize(datetime(2026, 10, 25, 3, 0), BERLIN, REJECT) == utc(2026, 10, 25, 2, 0)


def test_aware_times_keep_their_own_offset():
    aware = datetime.fromisoformat("2026-03-29T02:30:00+05:00")
    assert to_utc(aware, BERLIN, REJECT) == utc(2026, 3, 28, 21, 30)


def test_localize_refuses_aware_input():
    with pytest.raises(ValueError, match="naive"):
        localize(datetime(2026, 1, 1, tzinfo=UTC), BERLIN, REJECT)


def test_a_day_starts_at_the_transition_when_midnight_does_not_exist():
    sao_paulo = load_zone("America/Sao_Paulo")  # DST began at 00:00 on 2018-11-04
    assert start_of_day(date(2018, 11, 4), sao_paulo) == utc(2018, 11, 4, 3, 0)
    assert start_of_day(date(2018, 11, 5), sao_paulo) == utc(2018, 11, 5, 2, 0)


def test_day_bounds_cover_short_and_long_days():
    start, end = day_bounds(date(2026, 3, 29), date(2026, 3, 29), BERLIN)
    assert (start, end) == (utc(2026, 3, 28, 23, 0), utc(2026, 3, 29, 22, 0))
    assert (end - start).total_seconds() == 23 * 3600

    start, end = day_bounds(date(2026, 10, 25), date(2026, 10, 25), BERLIN)
    assert (end - start).total_seconds() == 25 * 3600


def test_day_bounds_refuse_an_inverted_range():
    with pytest.raises(ValueError, match="before"):
        day_bounds(date(2026, 3, 2), date(2026, 3, 1), BERLIN)


@pytest.mark.parametrize("name", ["Mars/Olympus", "../etc/passwd", "", "Europe"])
def test_unknown_zones_are_refused(name):
    with pytest.raises(ValueError, match="unknown time zone"):
        load_zone(name)
