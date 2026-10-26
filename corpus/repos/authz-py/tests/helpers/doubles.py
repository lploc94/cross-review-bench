"""Deterministic randomness and a mailer that keeps what it sends."""

from __future__ import annotations

import hashlib
import re
import uuid

from authz.infra.mailer import EmailMessage

_INVITATION_LINK = re.compile(r"/invitations/([A-Za-z0-9_-]+)")


class SeededRandom:
    """Implements authz.infra.randomness.RandomSource with reproducible values."""

    def __init__(self, seed: str = "authz-tests") -> None:
        self._seed = seed
        self._counter = 0

    def _next(self) -> bytes:
        self._counter += 1
        return hashlib.sha256(f"{self._seed}:{self._counter}".encode()).digest()

    def token(self, nbytes: int = 32) -> str:
        raw = b""
        while len(raw) < nbytes:
            raw += self._next()
        return raw[:nbytes].hex()

    def uuid(self) -> uuid.UUID:
        return uuid.UUID(bytes=self._next()[:16], version=4)


class RecordingMailer:
    def __init__(self) -> None:
        self.sent: list[EmailMessage] = []

    async def send(self, message: EmailMessage) -> None:
        self.sent.append(message)

    def to(self, address: str) -> list[EmailMessage]:
        return [message for message in self.sent if message.to == address]

    def last_invitation_token(self, address: str) -> str:
        messages = [m for m in self.to(address) if m.kind == "invitation"]
        assert messages, f"no invitation was sent to {address}"
        match = _INVITATION_LINK.search(messages[-1].body)
        assert match, "the invitation email has no link"
        return match.group(1)
