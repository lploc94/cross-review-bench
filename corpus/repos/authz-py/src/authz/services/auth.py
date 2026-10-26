"""Login, token refresh and logout."""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta

from sqlalchemy.ext.asyncio import AsyncSession

from authz.domain.emails import normalize_email
from authz.domain.principal import Principal
from authz.errors import (
    AuthenticationFailed,
    InvalidCredentials,
    InvalidInputError,
    InvalidToken,
    RateLimited,
)
from authz.infra.clock import Clock
from authz.infra.db import Database
from authz.infra.hashing import MAX_PASSWORD_LENGTH, PasswordHasher
from authz.infra.randomness import RandomSource, hash_token
from authz.infra.rate_limiter import RateLimiter, RateLimitRule
from authz.logging import get_logger
from authz.models import Session, User
from authz.repositories.sessions import RefreshTokenRepository, SessionRepository
from authz.repositories.users import UserRepository
from authz.services.tokens import AccessTokenCodec, IssuedAccessToken

log = get_logger(__name__)

MAX_DEVICE_LABEL_LENGTH = 100
MAX_USER_AGENT_LENGTH = 512


@dataclass(frozen=True, slots=True)
class AuthPolicy:
    refresh_token_ttl: timedelta
    session_ttl: timedelta
    login_rule: RateLimitRule
    refresh_rule: RateLimitRule


@dataclass(frozen=True, slots=True)
class ClientInfo:
    ip: str | None
    user_agent: str | None
    device_label: str | None = None


@dataclass(frozen=True, slots=True)
class TokenPair:
    access: IssuedAccessToken
    refresh_token: str
    session_id: uuid.UUID
    user_id: uuid.UUID


class AuthService:
    def __init__(
        self,
        *,
        db: Database,
        clock: Clock,
        random: RandomSource,
        hasher: PasswordHasher,
        tokens: AccessTokenCodec,
        limiter: RateLimiter,
        policy: AuthPolicy,
    ) -> None:
        self._db = db
        self._clock = clock
        self._random = random
        self._hasher = hasher
        self._tokens = tokens
        self._limiter = limiter
        self._policy = policy

    async def login(self, email: str, password: str, client: ClientInfo) -> TokenPair:
        """Exchange credentials for a new session. Every failure looks the same to the caller."""
        try:
            address = normalize_email(email)
        except InvalidInputError:
            address = email.strip().lower()
        await self._throttle(self._policy.login_rule, f"{address}|{client.ip or '-'}")

        if len(password) > MAX_PASSWORD_LENGTH:
            await self._hasher.verify_dummy(password[:MAX_PASSWORD_LENGTH])
            raise InvalidCredentials()

        async with self._db.read() as session:
            user = await UserRepository(session).get_by_email(address)
        if user is None:
            # Spend the time a real verification takes, so timing does not reveal accounts.
            await self._hasher.verify_dummy(password)
            log.info("auth.login_failed", reason="unknown_email")
            raise InvalidCredentials()
        if not await self._hasher.verify(user.password_hash, password):
            log.info("auth.login_failed", reason="bad_password", user_id=str(user.id))
            raise InvalidCredentials()
        if user.disabled_at is not None:
            log.info("auth.login_failed", reason="disabled", user_id=str(user.id))
            raise InvalidCredentials()

        new_hash = None
        if self._hasher.needs_rehash(user.password_hash):
            new_hash = await self._hasher.hash(password)
        async with self._db.transaction() as session:
            if new_hash is not None:
                await UserRepository(session).set_password_hash(
                    user.id, new_hash, self._clock.now()
                )
                log.info("auth.password_rehashed", user_id=str(user.id))
            pair = await self._open_session(session, user, client)
        log.info("auth.login", user_id=str(pair.user_id), session_id=str(pair.session_id))
        return pair

    async def _open_session(
        self, session: AsyncSession, user: User, client: ClientInfo
    ) -> TokenPair:
        now = self._clock.now()
        row = await SessionRepository(session).add(
            user_id=user.id,
            device_label=_clip(client.device_label, MAX_DEVICE_LABEL_LENGTH),
            ip=client.ip,
            user_agent=_clip(client.user_agent, MAX_USER_AGENT_LENGTH),
            now=now,
            expires_at=now + self._policy.session_ttl,
        )
        refresh = self._random.token()
        await RefreshTokenRepository(session).add(
            session_id=row.id,
            token_hash=hash_token(refresh),
            now=now,
            expires_at=self._refresh_expiry(row),
        )
        return TokenPair(
            access=self._tokens.issue(user.id, row.id),
            refresh_token=refresh,
            session_id=row.id,
            user_id=user.id,
        )

    def _refresh_expiry(self, row: Session) -> datetime:
        return min(self._clock.now() + self._policy.refresh_token_ttl, row.expires_at)

    async def refresh(self, refresh_token: str, client: ClientInfo) -> TokenPair:
        """Rotate a refresh token: the presented one is spent and a new one issued."""
        await self._throttle(self._policy.refresh_rule, client.ip or "-")
        now = self._clock.now()
        async with self._db.transaction() as session:
            tokens = RefreshTokenRepository(session)
            sessions = SessionRepository(session)
            current = await tokens.get_by_hash_for_update(hash_token(refresh_token))
            if current is None:
                raise InvalidToken()
            if current.used_at is not None:
                log.info("auth.refresh_rejected", reason="used", session_id=str(current.session_id))
                raise InvalidToken()
            if now >= current.expires_at:
                raise InvalidToken()
            login = await sessions.get(current.session_id, for_update=True)
            if login is None or not login.is_active(now):
                raise InvalidToken()
            user = await UserRepository(session).get(login.user_id)
            if user is None or user.disabled_at is not None:
                raise InvalidToken()

            new_refresh = self._random.token()
            replacement = await tokens.add(
                session_id=login.id,
                token_hash=hash_token(new_refresh),
                now=now,
                expires_at=self._refresh_expiry(login),
            )
            await tokens.mark_used(current, now, replacement.id)
            await sessions.touch(login, now, client.ip)
            access = self._tokens.issue(user.id, login.id)
        return TokenPair(
            access=access, refresh_token=new_refresh, session_id=login.id, user_id=user.id
        )

    async def logout(self, principal: Principal) -> None:
        if principal.session_id is None:
            return
        async with self._db.transaction() as session:
            sessions = SessionRepository(session)
            row = await sessions.get(principal.session_id, for_update=True)
            if row is not None and row.user_id == principal.user_id:
                await sessions.revoke(row, self._clock.now(), "logout")
        log.info("auth.logout", user_id=str(principal.user_id))

    async def authenticate(self, access_token: str, client: ClientInfo) -> Principal:
        """The principal behind a bearer token whose session and user are still active."""
        claims = self._tokens.decode(access_token)
        now = self._clock.now()
        async with self._db.read() as session:
            row = await SessionRepository(session).get(claims.session_id)
            if row is None or row.user_id != claims.user_id or not row.is_active(now):
                raise InvalidToken("the session has ended")
            user = await UserRepository(session).get(claims.user_id)
            if user is None or user.disabled_at is not None:
                raise AuthenticationFailed()
        return Principal.user(
            claims.user_id, claims.session_id, ip=client.ip, user_agent=client.user_agent
        )

    async def _throttle(self, rule: RateLimitRule, subject: str) -> None:
        result = await self._limiter.hit(rule, subject)
        if not result.allowed:
            log.info("auth.rate_limited", bucket=rule.name)
            raise RateLimited(result.retry_after)


def _clip(value: str | None, limit: int) -> str | None:
    if value is None:
        return None
    value = value.strip()
    return value[:limit] or None
