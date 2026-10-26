from __future__ import annotations

import pytest

from etl.domain.contact import normalise_country, normalise_email, normalise_phone


def test_emails_are_trimmed_and_lower_cased():
    assert normalise_email("  Ada.Example@Example.COM ") == "ada.example@example.com"


@pytest.mark.parametrize(
    "value", ["ada", "ada@", "@example.com", "ada@example", "a b@example.com", "ada@example..com"]
)
def test_invalid_emails_are_refused(value):
    with pytest.raises(ValueError, match="not an email address"):
        normalise_email(value)


@pytest.mark.parametrize(
    ("value", "country", "expected"),
    [
        ("+49 30 1234567", None, "+49301234567"),
        ("0049 (30) 123-4567", "FR", "+49301234567"),
        ("030 1234567", "DE", "+49301234567"),
        ("06 12 34 56 78", "FR", "+33612345678"),
        ("(212) 555-0187", "US", "+12125550187"),
        ("06 1234 5678", "IT", "+390612345678"),
        # "(0)" marks the trunk prefix, which the international form drops
        ("+49 (0)30 1234567", None, "+49301234567"),
        ("0044 (0) 20 7946 0958", "DE", "+442079460958"),
        # Italy keeps the 0 in the international form
        ("+39 (0)6 1234 5678", None, "+390612345678"),
        # in the North American plan the trunk prefix is 1
        ("1-212-555-1234", "US", "+12125551234"),
        ("1 (416) 555-0123", "CA", "+14165550123"),
    ],
)
def test_phone_numbers_become_international(value, country, expected):
    assert normalise_phone(value, country) == expected


@pytest.mark.parametrize(
    ("value", "country", "message"),
    [
        # national number, country unknown
        ("030 1234567", None, "without an international prefix"),
        # national number of a country without a calling code here
        ("030 1234567", "BR", "without an international prefix"),
        ("30 1234567", "DE", "without its trunk prefix"),
        ("+49 12", None, "8 to 15 digits"),
        ("+49 1234 5678 9012 3456", None, "8 to 15 digits"),
        ("+49 30 CALL-NOW", None, "not a phone number"),
        ("+0 30 1234567", None, "not a phone number"),
        # "(0)" only stands right after the country code
        ("+44 20 7946 0958 (0)", None, "trunk prefix"),
        ("+44 20 (0)7946 0958", None, "trunk prefix"),
        ("+\uff14\uff19 30 1234567", None, "not a phone number"),  # non-ASCII digits
    ],
)
def test_invalid_phone_numbers_are_refused(value, country, message):
    with pytest.raises(ValueError, match=message):
        normalise_phone(value, country)


def test_country_codes_are_upper_cased_and_checked():
    assert normalise_country(" de ") == "DE"
    with pytest.raises(ValueError, match="alpha-2"):
        normalise_country("XX")
    with pytest.raises(ValueError, match="alpha-2"):
        normalise_country("DEU")
