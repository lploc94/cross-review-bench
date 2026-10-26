"""Queries on login sessions and their refresh tokens."""

from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from authz.models import RefreshToken, Session


class SessionRepository:
    def __init__(self, session: AsyncSession) -> None:
        self._session = session

    async def add(
        self,
        *,
        user_id: uuid.UUID,
        device_label: str | None,
        ip: str | None,
        user_agent: str | None,
        now: datetime,
        expires_at: datetime,
    ) -> Session:
        row = Session(
            id=uuid.uuid4(),
            user_id=user_id,
            device_label=device_label,
            ip=ip,
            user_agent=user_agent,
            created_at=now,
            last_used_at=now,
            expires_at=expires_at,
        )
        self._session.add(row)
        await self._session.flush()
        return row

    async def get(self, session_id: uuid.UUID, *, for_update: bool = False) -> Session | None:
        query = select(Session).where(Session.id == session_id)
        if for_update:
            query = query.with_for_update()
        result = await self._session.execute(query)
        return result.scalar_one_or_none()

    async def get_for_user(self, user_id: uuid.UUID, session_id: uuid.UUID) -> Session | None:
        result = await self._session.execute(
            select(Session).where(Session.id == session_id, Session.user_id == user_id)
        )
        return result.scalar_one_or_none()

    async def list_active(self, user_id: uuid.UUID, now: datetime) -> list[Session]:
        result = await self._session.execute(
            select(Session)
            .where(
                Session.user_id == user_id,
                Session.revoked_at.is_(None),
                Session.expires_at > now,
            )
            .order_by(Session.last_used_at.desc(), Session.id)
        )
        return list(result.scalars())

    async def touch(self, row: Session, now: datetime, ip: str | None) -> None:
        row.last_used_at = now
        if ip:
            row.ip = ip
        await self._session.flush()

    async def revoke(self, row: Session, now: datetime, reason: str) -> bool:
        """Revoke one session; False when it already was."""
        if row.revoked_at is not None:
            return False
        row.revoked_at = now
        row.revoked_reason = reason
        await self._session.flush()
        return True


class RefreshTokenRepository:
    def __init__(self, session: AsyncSession) -> None:
        self._session = session

    async def add(
        self, *, session_id: uuid.UUID, token_hash: str, now: datetime, expires_at: datetime
    ) -> RefreshToken:
        row = RefreshToken(
            id=uuid.uuid4(),
            session_id=session_id,
            token_hash=token_hash,
            created_at=now,
            expires_at=expires_at,
        )
        self._session.add(row)
        await self._session.flush()
        return row

    async def get_by_hash_for_update(self, token_hash: str) -> RefreshToken | None:
        """Lock the token row, so two refreshes with one token cannot both succeed."""
        result = await self._session.execute(
            select(RefreshToken).where(RefreshToken.token_hash == token_hash).with_for_update()
        )
        return result.scalar_one_or_none()

    async def mark_used(
        self, row: RefreshToken, now: datetime, replaced_by: uuid.UUID | None
    ) -> None:
        row.used_at = now
        row.replaced_by_id = replaced_by
        await self._session.flush()
