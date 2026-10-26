"""Random values for secrets, and the hashing of secrets that are stored."""

from __future__ import annotations

import hashlib
import hmac
import secrets
import uuid
from typing import Protocol

TOKEN_BYTES = 32


class RandomSource(Protocol):
    def token(self, nbytes: int = TOKEN_BYTES) -> str:
        """A URL-safe random string carrying nbytes of entropy."""
        ...

    def uuid(self) -> uuid.UUID: ...


class SecureRandom:
    def token(self, nbytes: int = TOKEN_BYTES) -> str:
        return secrets.token_urlsafe(nbytes)

    def uuid(self) -> uuid.UUID:
        return uuid.uuid4()


def hash_token(token: str) -> str:
    """The value stored for an opaque token: lookups compare hashes, never the token itself."""
    return hashlib.sha256(token.encode()).hexdigest()


def tokens_equal(left: str, right: str) -> bool:
    return hmac.compare_digest(left.encode(), right.encode())
