from __future__ import annotations

import pytest

from authz.domain.emails import is_valid_email, normalize_email
from authz.errors import InvalidInputError


def test_normalises_case_and_whitespace():
    assert normalize_email("  Jane.Doe+Work@Example.COM ") == "jane.doe+work@example.com"


@pytest.mark.parametrize(
    "address",
    [
        "",
        "plainaddress",
        "two@@example.com",
        "a@b@example.com",
        ".leading@example.com",
        "double..dot@example.com",
        "user@localhost",
        "user@-bad.example.com",
        "user@example.123",
        f"{'x' * 65}@example.com",
    ],
)
def test_rejects_invalid_addresses(address):
    with pytest.raises(InvalidInputError):
        normalize_email(address)


def test_is_valid_email():
    assert is_valid_email("ok@example.com")
    assert not is_valid_email("nope")
