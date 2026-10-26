"""Opaque keyset cursors: base64url JSON of the last row's sort key."""

from __future__ import annotations

import base64
import binascii
import json
import uuid
from dataclasses import dataclass
from datetime import datetime

from authz.errors import InvalidInputError

DEFAULT_LIMIT = 50
MAX_LIMIT = 200


@dataclass(frozen=True, slots=True)
class Cursor:
    """Position after a row ordered by (created_at, id)."""

    created_at: datetime
    id: str

    def encode(self) -> str:
        payload = json.dumps(
            {"t": self.created_at.isoformat(), "i": self.id}, separators=(",", ":")
        )
        return base64.urlsafe_b64encode(payload.encode()).decode().rstrip("=")

    @classmethod
    def decode(cls, raw: str) -> Cursor:
        try:
            padded = raw + "=" * (-len(raw) % 4)
            data = json.loads(base64.urlsafe_b64decode(padded.encode()))
            created_at = datetime.fromisoformat(data["t"])
            row_id = str(data["i"])
        except (binascii.Error, ValueError, KeyError, TypeError, UnicodeDecodeError):
            raise InvalidInputError("malformed cursor", details={"field": "cursor"}) from None
        if created_at.tzinfo is None:
            raise InvalidInputError("malformed cursor", details={"field": "cursor"})
        return cls(created_at=created_at, id=row_id)

    def id_as_uuid(self) -> uuid.UUID:
        try:
            return uuid.UUID(self.id)
        except ValueError:
            raise InvalidInputError("malformed cursor", details={"field": "cursor"}) from None

    def id_as_int(self) -> int:
        if not self.id.isdigit():
            raise InvalidInputError("malformed cursor", details={"field": "cursor"})
        return int(self.id)


@dataclass(frozen=True, slots=True)
class Page[T]:
    items: list[T]
    next_cursor: str | None


def clamp_limit(limit: int | None) -> int:
    if limit is None:
        return DEFAULT_LIMIT
    if limit < 1 or limit > MAX_LIMIT:
        raise InvalidInputError(
            f"limit must be between 1 and {MAX_LIMIT}", details={"field": "limit"}
        )
    return limit
