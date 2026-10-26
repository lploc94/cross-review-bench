from __future__ import annotations

from datetime import UTC, datetime

import pytest

from authz.domain.pagination import MAX_LIMIT, Cursor, clamp_limit
from authz.errors import InvalidInputError


def test_cursor_round_trip():
    cursor = Cursor(created_at=datetime(2026, 1, 2, 3, 4, 5, 678, tzinfo=UTC), id="42")

    decoded = Cursor.decode(cursor.encode())

    assert decoded == cursor
    assert decoded.id_as_int() == 42


@pytest.mark.parametrize("raw", ["!!!", "e30", "bm90IGpzb24"])
def test_malformed_cursors_are_rejected(raw):
    with pytest.raises(InvalidInputError):
        Cursor.decode(raw)


def test_cursor_ids_are_checked_when_used():
    cursor = Cursor(created_at=datetime(2026, 1, 1, tzinfo=UTC), id="abc")

    with pytest.raises(InvalidInputError):
        cursor.id_as_int()
    with pytest.raises(InvalidInputError):
        cursor.id_as_uuid()


def test_clamp_limit():
    assert clamp_limit(None) == 50
    assert clamp_limit(MAX_LIMIT) == MAX_LIMIT
    with pytest.raises(InvalidInputError):
        clamp_limit(MAX_LIMIT + 1)
