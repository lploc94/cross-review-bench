"""Normalisation of contact data: email addresses, phone numbers and country codes."""

from __future__ import annotations

import re

# ISO 3166-1 alpha-2, officially assigned codes.
_ASSIGNED_COUNTRY_CODES = """
    AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR
    BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ
    EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW
    GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY
    KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV
    MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY
    QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG
    TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM
    ZW
"""
COUNTRY_CODES = frozenset(_ASSIGNED_COUNTRY_CODES.split())

# Country calling codes used to complete national numbers, for the countries the retailer
# ships to. A national number elsewhere must be written with its international prefix.
CALLING_CODES: dict[str, str] = {
    "AT": "43",
    "BE": "32",
    "CA": "1",
    "CH": "41",
    "CZ": "420",
    "DE": "49",
    "DK": "45",
    "ES": "34",
    "FI": "358",
    "FR": "33",
    "GB": "44",
    "IE": "353",
    "IT": "39",
    "LU": "352",
    "NL": "31",
    "NO": "47",
    "PL": "48",
    "PT": "351",
    "SE": "46",
    "US": "1",
}

# The North American Numbering Plan: 10-digit national numbers, which may be dialled with
# the trunk prefix 1 (`1 212 555 0187`); the international form drops it.
_NANP = frozenset(code for code, calling in CALLING_CODES.items() if calling == "1")
_NANP_NATIONAL_DIGITS = 10

# Countries whose national numbers start with a trunk prefix 0 that the international
# form drops (Italy keeps its leading 0; the North American trunk prefix is 1, see _NANP).
_TRUNK_ZERO = frozenset(CALLING_CODES) - {"IT"} - _NANP

E164_MIN_DIGITS = 8
E164_MAX_DIGITS = 15

_EMAIL = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s.]{2,}$")
_PHONE_FORMATTING = re.compile(r"[\s\-().\/]")
# `+44 (0)20 7946 0958`: the trunk prefix in parentheses right after the country code,
# dialled only within the country. Anywhere else in the number it is refused.
_TRUNK_MARKER = re.compile(r"\(\s*0\s*\)")
_TRUNK_AFTER_CODE = re.compile(r"^(\+|00)[\s\-.]*([1-9][0-9]{0,2})[\s\-.]*\(\s*0\s*\)")
# Italy's numbers keep their leading 0 in the international form (`+39 06 ...`).
_KEEPS_TRUNK_ZERO = CALLING_CODES["IT"]
_DIGITS = re.compile(r"^[0-9]+$")


def normalise_email(value: str) -> str:
    """Trimmed and lower-cased; ValueError when it does not look like an address."""
    email = value.strip().lower()
    if not _EMAIL.match(email) or ".." in email.split("@", 1)[1]:
        raise ValueError("not an email address")
    return email


def normalise_country(value: str) -> str:
    """An ISO 3166-1 alpha-2 code, upper-cased."""
    code = value.strip().upper()
    if code not in COUNTRY_CODES:
        raise ValueError("not an ISO 3166-1 alpha-2 country code")
    return code


def normalise_phone(value: str, country: str | None) -> str:
    """A phone number as `+` and 8 to 15 digits (E.164 without its length rules per country).

    `+49 30 1234567` and `0049 30 1234567` keep their country code; a trunk prefix written
    right after it in parentheses (`+49 (0)30 1234567`) is dropped, except for Italy, whose
    numbers keep the 0 (`+39 (0)6 ...`). A national number
    (`030 1234567`) is completed with the calling code of `country` when it is one of
    CALLING_CODES, dropping the trunk prefix where the country uses one (0, or 1 in front of
    a 10-digit North American number).
    """
    text = value.strip()
    compact = _PHONE_FORMATTING.sub("", text)
    if compact.startswith(("+", "00")):
        marker = _TRUNK_AFTER_CODE.match(text)
        if marker is not None:
            prefix, code = marker.group(1, 2)
            trunk = "0" if code == _KEEPS_TRUNK_ZERO else ""
            text = prefix + code + trunk + text[marker.end() :]
        if _TRUNK_MARKER.search(text):
            raise ValueError("a trunk prefix (0) only follows the country code")
        compact = _PHONE_FORMATTING.sub("", text)
    if compact.startswith("+"):
        digits = compact[1:]
    elif compact.startswith("00"):
        digits = compact[2:]
    elif country is not None and country in CALLING_CODES:
        national = compact
        if country in _TRUNK_ZERO:
            if not national.startswith("0"):
                raise ValueError("national number without its trunk prefix 0")
            national = national[1:]
        elif country in _NANP and len(national) == _NANP_NATIONAL_DIGITS + 1:
            national = national.removeprefix("1")
        digits = CALLING_CODES[country] + national
    else:
        raise ValueError("phone number without an international prefix")
    if not _DIGITS.match(digits) or digits.startswith("0"):
        raise ValueError("not a phone number")
    if not E164_MIN_DIGITS <= len(digits) <= E164_MAX_DIGITS:
        raise ValueError(f"a phone number has {E164_MIN_DIGITS} to {E164_MAX_DIGITS} digits")
    return "+" + digits
