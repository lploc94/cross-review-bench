"""Queries on the audit log."""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import and_, insert, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from authz.domain.pagination import Cursor
from authz.models import AuditEvent


class AuditRepository:
    def __init__(self, session: AsyncSession) -> None:
        self._session = session

    async def append(
        self,
        *,
        org_id: uuid.UUID,
        actor_id: uuid.UUID | None,
        action: str,
        target_type: str,
        target_id: str | None,
        data: dict[str, Any],
        ip: str | None,
        created_at: datetime,
    ) -> int:
        result = await self._session.execute(
            insert(AuditEvent)
            .values(
                org_id=org_id,
                actor_id=actor_id,
                action=action,
                target_type=target_type,
                target_id=target_id,
                data=data,
                ip=ip,
                created_at=created_at,
            )
            .returning(AuditEvent.id)
        )
        return result.scalar_one()

    async def page(
        self,
        org_id: uuid.UUID,
        *,
        limit: int,
        after: Cursor | None,
        action: str | None = None,
    ) -> list[AuditEvent]:
        """Newest first by (created_at, id); fetches `limit + 1` rows to detect a next page."""
        query = select(AuditEvent).where(AuditEvent.org_id == org_id)
        if action is not None:
            query = query.where(AuditEvent.action == action)
        if after is not None:
            after_id = after.id_as_int()
            query = query.where(
                or_(
                    AuditEvent.created_at < after.created_at,
                    and_(AuditEvent.created_at == after.created_at, AuditEvent.id < after_id),
                )
            )
        result = await self._session.execute(
            query.order_by(AuditEvent.created_at.desc(), AuditEvent.id.desc()).limit(limit + 1)
        )
        return list(result.scalars())
