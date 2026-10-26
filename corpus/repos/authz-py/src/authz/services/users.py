"""User accounts and the caller's own sessions."""

from __future__ import annotations

import uuid
from dataclasses import dataclass

from authz.domain.emails import normalize_email
from authz.domain.principal import Principal
from authz.errors import InvalidInputError, NotFoundError
from authz.infra.clock import Clock
from authz.infra.db import Database
from authz.infra.hashing import MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH, PasswordHasher
from authz.logging import get_logger
from authz.models import Session, User
from authz.repositories.sessions import SessionRepository
from authz.repositories.users import UserRepository

log = get_logger(__name__)

MAX_DISPLAY_NAME_LENGTH = 100


def validate_password(password: str) -> None:
    if len(password) < MIN_PASSWORD_LENGTH:
        raise InvalidInputError(
            f"the password must have at least {MIN_PASSWORD_LENGTH} characters",
            details={"field": "password"},
        )
    if len(password) > MAX_PASSWORD_LENGTH:
        raise InvalidInputError(
            f"the password must have at most {MAX_PASSWORD_LENGTH} characters",
            details={"field": "password"},
        )
    if password.strip() != password or not password.strip():
        raise InvalidInputError(
            "the password must not start or end with whitespace", details={"field": "password"}
        )


def clean_display_name(value: str) -> str:
    name = " ".join(value.split())
    if len(name) > MAX_DISPLAY_NAME_LENGTH:
        raise InvalidInputError(
            f"the display name must have at most {MAX_DISPLAY_NAME_LENGTH} characters",
            details={"field": "display_name"},
        )
    return name


class UserService:
    def __init__(self, *, db: Database, clock: Clock, hasher: PasswordHasher) -> None:
        self._db = db
        self._clock = clock
        self._hasher = hasher

    async def create(self, *, email: str, password: str, display_name: str = "") -> User:
        address = normalize_email(email)
        validate_password(password)
        name = clean_display_name(display_name)
        password_hash = await self._hasher.hash(password)
        async with self._db.transaction() as session:
            user = await UserRepository(session).add(
                email=address,
                password_hash=password_hash,
                display_name=name,
                now=self._clock.now(),
            )
        log.info("user.created", user_id=str(user.id))
        return user

    async def get(self, user_id: uuid.UUID) -> User:
        async with self._db.read() as session:
            user = await UserRepository(session).get(user_id)
        if user is None:
            raise NotFoundError("user")
        return user

    async def get_by_email(self, email: str) -> User | None:
        async with self._db.read() as session:
            return await UserRepository(session).get_by_email(normalize_email(email))

    async def update_profile(self, principal: Principal, *, display_name: str) -> User:
        name = clean_display_name(display_name)
        async with self._db.transaction() as session:
            users = UserRepository(session)
            user = await users.get(principal.user_id)
            if user is None:
                raise NotFoundError("user")
            await users.set_display_name(user, name, self._clock.now())
        return user


@dataclass(frozen=True, slots=True)
class SessionView:
    session: Session
    current: bool


class SessionService:
    def __init__(self, *, db: Database, clock: Clock) -> None:
        self._db = db
        self._clock = clock

    async def list_own(self, principal: Principal) -> list[SessionView]:
        async with self._db.read() as session:
            rows = await SessionRepository(session).list_active(
                principal.user_id, self._clock.now()
            )
        return [SessionView(row, row.id == principal.session_id) for row in rows]

    async def revoke_own(self, principal: Principal, session_id: uuid.UUID) -> None:
        """Revoke one of the caller's sessions; somebody else's answers 404."""
        async with self._db.transaction() as session:
            sessions = SessionRepository(session)
            row = await sessions.get_for_user(principal.user_id, session_id)
            if row is None or row.revoked_at is not None:
                raise NotFoundError("session")
            await sessions.revoke(row, self._clock.now(), "revoked_by_user")
        log.info("session.revoked", user_id=str(principal.user_id), session_id=str(session_id))
