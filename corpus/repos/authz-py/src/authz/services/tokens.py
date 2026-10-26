"""JWT access tokens (HS256) with secret rotation."""

from __future__ import annotations

import uuid
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any

import jwt

from authz.errors import InvalidToken
from authz.infra.clock import Clock, epoch_seconds
from authz.infra.randomness import RandomSource

ALGORITHM = "HS256"
REQUIRED_CLAIMS = ("sub", "sid", "iat", "exp", "jti", "iss")


@dataclass(frozen=True, slots=True)
class AccessClaims:
    user_id: uuid.UUID
    session_id: uuid.UUID
    issued_at: datetime
    expires_at: datetime
    token_id: str


@dataclass(frozen=True, slots=True)
class IssuedAccessToken:
    token: str
    claims: AccessClaims

    @property
    def expires_in(self) -> int:
        return int((self.claims.expires_at - self.claims.issued_at).total_seconds())


class AccessTokenCodec:
    """Signs with the first secret and accepts a signature by any of them.

    Rotation: put the new secret first, keep the old one second until the longest-lived access
    token signed with it has expired, then drop it.
    """

    def __init__(
        self,
        secrets: Sequence[str],
        *,
        issuer: str,
        ttl_seconds: int,
        leeway_seconds: int,
        clock: Clock,
        random: RandomSource,
    ) -> None:
        if not secrets:
            raise ValueError("at least one signing secret is required")
        self._secrets = tuple(secrets)
        self._issuer = issuer
        self._ttl = timedelta(seconds=ttl_seconds)
        self._leeway = timedelta(seconds=leeway_seconds)
        self._clock = clock
        self._random = random

    def issue(self, user_id: uuid.UUID, session_id: uuid.UUID) -> IssuedAccessToken:
        now = self._clock.now().replace(microsecond=0)
        claims = AccessClaims(
            user_id=user_id,
            session_id=session_id,
            issued_at=now,
            expires_at=now + self._ttl,
            token_id=self._random.token(16),
        )
        payload = {
            "iss": self._issuer,
            "sub": str(user_id),
            "sid": str(session_id),
            "iat": epoch_seconds(claims.issued_at),
            "exp": epoch_seconds(claims.expires_at),
            "jti": claims.token_id,
        }
        token = jwt.encode(payload, self._secrets[0], algorithm=ALGORITHM)
        return IssuedAccessToken(token=token, claims=claims)

    def decode(self, token: str) -> AccessClaims:
        """Verified claims of a token, or InvalidToken. Expiry is judged by the service clock."""
        payload = self._verify_signature(token)
        try:
            claims = AccessClaims(
                user_id=uuid.UUID(str(payload["sub"])),
                session_id=uuid.UUID(str(payload["sid"])),
                issued_at=datetime.fromtimestamp(int(payload["iat"]), UTC),
                expires_at=datetime.fromtimestamp(int(payload["exp"]), UTC),
                token_id=str(payload["jti"]),
            )
        except (KeyError, ValueError, TypeError, OverflowError):
            raise InvalidToken() from None
        now = self._clock.now()
        if now >= claims.expires_at + self._leeway:
            raise InvalidToken("the access token has expired")
        if claims.issued_at > now + self._leeway:
            raise InvalidToken()
        return claims

    def _verify_signature(self, token: str) -> dict[str, Any]:
        for secret in self._secrets:
            try:
                payload: dict[str, Any] = jwt.decode(
                    token,
                    secret,
                    algorithms=[ALGORITHM],
                    issuer=self._issuer,
                    options={
                        "require": list(REQUIRED_CLAIMS),
                        "verify_exp": False,
                        "verify_iat": False,
                        "verify_nbf": False,
                    },
                )
            except jwt.InvalidSignatureError:
                continue
            except jwt.InvalidTokenError:
                raise InvalidToken() from None
            return payload
        raise InvalidToken()
