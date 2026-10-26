"""Queries on invitations."""

from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from authz.models import Invitation


class InvitationRepository:
    def __init__(self, session: AsyncSession) -> None:
        self._session = session

    async def add(
        self,
        *,
        org_id: uuid.UUID,
        email: str,
        role_id: uuid.UUID,
        token_hash: str,
        invited_by: uuid.UUID | None,
        now: datetime,
        expires_at: datetime,
    ) -> Invitation:
        invitation = Invitation(
            id=uuid.uuid4(),
            org_id=org_id,
            email=email,
            role_id=role_id,
            token_hash=token_hash,
            invited_by=invited_by,
            created_at=now,
            expires_at=expires_at,
        )
        self._session.add(invitation)
        await self._session.flush()
        return invitation

    async def get_by_hash_for_update(self, token_hash: str) -> Invitation | None:
        result = await self._session.execute(
            select(Invitation).where(Invitation.token_hash == token_hash).with_for_update()
        )
        return result.scalar_one_or_none()

    async def find_pending(self, org_id: uuid.UUID, email: str, now: datetime) -> Invitation | None:
        result = await self._session.execute(
            select(Invitation)
            .where(
                Invitation.org_id == org_id,
                Invitation.email == email,
                Invitation.accepted_at.is_(None),
                Invitation.expires_at > now,
            )
            .order_by(Invitation.created_at.desc())
            .limit(1)
        )
        return result.scalar_one_or_none()

    async def list_pending(self, org_id: uuid.UUID, now: datetime) -> list[Invitation]:
        result = await self._session.execute(
            select(Invitation)
            .where(
                Invitation.org_id == org_id,
                Invitation.accepted_at.is_(None),
                Invitation.expires_at > now,
            )
            .order_by(Invitation.created_at.desc(), Invitation.id)
        )
        return list(result.scalars())

    async def mark_accepted(
        self, invitation: Invitation, user_id: uuid.UUID, now: datetime
    ) -> None:
        invitation.accepted_at = now
        invitation.accepted_by = user_id
        await self._session.flush()
