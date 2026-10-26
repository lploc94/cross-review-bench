"""Queries on projects."""

from __future__ import annotations

import uuid
from collections.abc import Collection
from datetime import datetime

from sqlalchemy import and_, or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from authz.domain.pagination import Cursor
from authz.errors import ConflictError
from authz.models import Project


def _name_conflict(name: str) -> ConflictError:
    return ConflictError(f"a project named '{name}' already exists", details={"field": "name"})


class ProjectRepository:
    def __init__(self, session: AsyncSession) -> None:
        self._session = session

    async def add(
        self,
        *,
        org_id: uuid.UUID,
        name: str,
        description: str,
        created_by: uuid.UUID | None,
        now: datetime,
    ) -> Project:
        project = Project(
            id=uuid.uuid4(),
            org_id=org_id,
            name=name,
            description=description,
            created_by=created_by,
            created_at=now,
            updated_at=now,
        )
        self._session.add(project)
        try:
            async with self._session.begin_nested():
                await self._session.flush()
        except IntegrityError:
            raise _name_conflict(name) from None
        return project

    async def get(
        self, org_id: uuid.UUID, project_id: uuid.UUID, *, for_update: bool = False
    ) -> Project | None:
        query = select(Project).where(Project.org_id == org_id, Project.id == project_id)
        if for_update:
            query = query.with_for_update()
        result = await self._session.execute(query)
        return result.scalar_one_or_none()

    async def exists(self, org_id: uuid.UUID, project_id: uuid.UUID) -> bool:
        result = await self._session.execute(
            select(Project.id).where(Project.org_id == org_id, Project.id == project_id)
        )
        return result.scalar_one_or_none() is not None

    async def page(
        self,
        org_id: uuid.UUID,
        *,
        include_archived: bool,
        limit: int,
        after: Cursor | None,
        only_ids: Collection[uuid.UUID] | None = None,
    ) -> list[Project]:
        """Projects newest first; `only_ids` restricts the list to projects the caller may read."""
        query = select(Project).where(Project.org_id == org_id)
        if not include_archived:
            query = query.where(Project.archived_at.is_(None))
        if only_ids is not None:
            if not only_ids:
                return []
            query = query.where(Project.id.in_(list(only_ids)))
        if after is not None:
            after_id = after.id_as_uuid()
            query = query.where(
                or_(
                    Project.created_at < after.created_at,
                    and_(Project.created_at == after.created_at, Project.id < after_id),
                )
            )
        result = await self._session.execute(
            query.order_by(Project.created_at.desc(), Project.id.desc()).limit(limit + 1)
        )
        return list(result.scalars())

    async def update(
        self,
        project: Project,
        *,
        name: str,
        description: str,
        archived_at: datetime | None,
        now: datetime,
    ) -> None:
        project.name = name
        project.description = description
        project.archived_at = archived_at
        project.updated_at = now
        try:
            async with self._session.begin_nested():
                await self._session.flush()
        except IntegrityError:
            raise _name_conflict(name) from None

    async def delete(self, project: Project) -> None:
        await self._session.delete(project)
        await self._session.flush()
