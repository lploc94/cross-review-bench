"""Queries on users."""

from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import func, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from authz.errors import ConflictError
from authz.models import User


class UserRepository:
    def __init__(self, session: AsyncSession) -> None:
        self._session = session

    async def get(self, user_id: uuid.UUID) -> User | None:
        return await self._session.get(User, user_id)

    async def get_by_email(self, email: str) -> User | None:
        """Look a user up by an already normalised address."""
        result = await self._session.execute(
            select(User).where(func.lower(User.email) == email.lower())
        )
        return result.scalar_one_or_none()

    async def get_many(self, user_ids: list[uuid.UUID]) -> dict[uuid.UUID, User]:
        if not user_ids:
            return {}
        result = await self._session.execute(select(User).where(User.id.in_(user_ids)))
        return {user.id: user for user in result.scalars()}

    async def add(
        self, *, email: str, password_hash: str, display_name: str, now: datetime
    ) -> User:
        user = User(
            id=uuid.uuid4(),
            email=email,
            password_hash=password_hash,
            display_name=display_name,
            created_at=now,
            updated_at=now,
        )
        self._session.add(user)
        try:
            async with self._session.begin_nested():
                await self._session.flush()
        except IntegrityError:
            raise ConflictError(
                "a user with this email already exists", details={"field": "email"}
            ) from None
        return user

    async def set_password_hash(
        self, user_id: uuid.UUID, password_hash: str, now: datetime
    ) -> None:
        await self._session.execute(
            update(User)
            .where(User.id == user_id)
            .values(password_hash=password_hash, updated_at=now)
        )

    async def set_display_name(self, user: User, display_name: str, now: datetime) -> None:
        user.display_name = display_name
        user.updated_at = now
        await self._session.flush()
