"""Writing and reading the audit log."""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import datetime
from enum import StrEnum
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from authz.domain.pagination import Cursor, Page, clamp_limit
from authz.domain.principal import Actor
from authz.infra.clock import Clock
from authz.infra.db import Database
from authz.models import AuditEvent
from authz.repositories.audit import AuditRepository


class AuditAction(StrEnum):
    ORG_CREATED = "org.created"
    ORG_UPDATED = "org.updated"
    MEMBER_ADDED = "member.added"
    MEMBER_ROLE_CHANGED = "member.role_changed"
    MEMBER_REMOVED = "member.removed"
    ROLE_CREATED = "role.created"
    ROLE_UPDATED = "role.updated"
    ROLE_DELETED = "role.deleted"
    ROLE_ASSIGNED = "role_assignment.created"
    ROLE_UNASSIGNED = "role_assignment.deleted"
    PROJECT_CREATED = "project.created"
    PROJECT_UPDATED = "project.updated"
    PROJECT_ARCHIVED = "project.archived"
    PROJECT_RESTORED = "project.restored"
    PROJECT_DELETED = "project.deleted"
    INVITATION_CREATED = "invitation.created"
    INVITATION_ACCEPTED = "invitation.accepted"


@dataclass(frozen=True, slots=True)
class AuditEntry:
    """One change, before it is written."""

    org_id: uuid.UUID
    action: AuditAction
    target_type: str
    target_id: str | None
    data: dict[str, Any]


class AuditLog:
    """Appends events inside the caller's transaction, so an event exists iff its change does."""

    def __init__(self, clock: Clock) -> None:
        self._clock = clock

    async def record(
        self,
        session: AsyncSession,
        actor: Actor,
        *,
        org_id: uuid.UUID,
        action: AuditAction,
        target_type: str,
        target_id: object | None = None,
        data: dict[str, Any] | None = None,
    ) -> AuditEntry:
        entry = AuditEntry(
            org_id=org_id,
            action=action,
            target_type=target_type,
            target_id=None if target_id is None else str(target_id),
            data=_jsonable(data or {}),
        )
        await AuditRepository(session).append(
            org_id=entry.org_id,
            actor_id=actor.user_id,
            action=entry.action.value,
            target_type=entry.target_type,
            target_id=entry.target_id,
            data=entry.data,
            ip=actor.ip,
            created_at=self._clock.now(),
        )
        return entry


def _jsonable(value: Any) -> Any:
    if isinstance(value, dict):
        return {str(key): _jsonable(item) for key, item in value.items()}
    if isinstance(value, list | tuple | set | frozenset):
        items = [_jsonable(item) for item in value]
        return sorted(items, key=str) if isinstance(value, set | frozenset) else items
    if isinstance(value, uuid.UUID):
        return str(value)
    if isinstance(value, datetime):
        return value.isoformat()
    return value


class AuditQueryService:
    def __init__(self, db: Database) -> None:
        self._db = db

    async def page(
        self,
        org_id: uuid.UUID,
        *,
        cursor: str | None,
        limit: int | None,
        action: str | None = None,
    ) -> Page[AuditEvent]:
        size = clamp_limit(limit)
        after = Cursor.decode(cursor) if cursor else None
        async with self._db.read() as session:
            rows = await AuditRepository(session).page(
                org_id, limit=size, after=after, action=action
            )
        items = rows[:size]
        next_cursor = None
        if len(rows) > size:
            last = items[-1]
            next_cursor = Cursor(created_at=last.created_at, id=str(last.id)).encode()
        return Page(items=items, next_cursor=next_cursor)
