"""Email address validation and normalisation.

Addresses are compared case-insensitively: the whole address is lower-cased and trimmed before
it is stored or looked up. Validation is deliberately practical (RFC 5321 lengths, a dot-atom
local part, a host name with a dotted domain) rather than a full RFC 5322 parser.
"""

from __future__ import annotations

import re
import unicodedata

from authz.errors import InvalidInputError

MAX_ADDRESS_LENGTH = 254
MAX_LOCAL_LENGTH = 64
MAX_LABEL_LENGTH = 63

_LOCAL_ATOM = re.compile(r"^[a-z0-9!#$%&'*+/=?^_`{|}~-]+$")
_LABEL = re.compile(r"^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$")


def normalize_email(raw: str) -> str:
    """The canonical form of an address, or InvalidInputError."""
    address = unicodedata.normalize("NFKC", raw).strip().lower()
    problem = _problem(address)
    if problem:
        raise InvalidInputError(f"invalid email address: {problem}", details={"field": "email"})
    return address


def is_valid_email(raw: str) -> bool:
    try:
        normalize_email(raw)
    except InvalidInputError:
        return False
    return True


def _problem(address: str) -> str | None:
    if not address:
        return "empty"
    if len(address) > MAX_ADDRESS_LENGTH:
        return "too long"
    if address.count("@") != 1:
        return "must contain exactly one @"
    local, domain = address.split("@")
    if not local or len(local) > MAX_LOCAL_LENGTH:
        return "invalid local part"
    atoms = local.split(".")
    if any(not atom or not _LOCAL_ATOM.match(atom) for atom in atoms):
        return "invalid local part"
    return _domain_problem(domain)


def _domain_problem(domain: str) -> str | None:
    labels = domain.split(".")
    if len(labels) < 2:
        return "the domain needs a dot"
    for label in labels:
        if not label or len(label) > MAX_LABEL_LENGTH or not _LABEL.match(label):
            return "invalid domain"
    if labels[-1].isdigit():
        return "invalid top-level domain"
    return None


def email_domain(address: str) -> str:
    return address.rsplit("@", 1)[1]
