"""Projects: the tenant resource the permissions protect."""

from __future__ import annotations

import uuid
from dataclasses import dataclass

from authz.domain.pagination import Cursor, Page, clamp_limit
from authz.domain.principal import Actor, Principal
from authz.errors import InvalidInputError, NotFoundError
from authz.infra.clock import Clock
from authz.infra.db import Database
from authz.models import Project
from authz.repositories.projects import ProjectRepository
from authz.services.audit import AuditAction, AuditLog
from authz.services.authorization import AuthorizationService

MAX_NAME_LENGTH = 100
MAX_DESCRIPTION_LENGTH = 2000


def clean_project_name(name: str) -> str:
    cleaned = " ".join(name.split())
    if not cleaned or len(cleaned) > MAX_NAME_LENGTH:
        raise InvalidInputError(
            f"the name must have 1 to {MAX_NAME_LENGTH} characters", details={"field": "name"}
        )
    return cleaned


def clean_description(description: str) -> str:
    text = description.strip()
    if len(text) > MAX_DESCRIPTION_LENGTH:
        raise InvalidInputError(
            f"the description must have at most {MAX_DESCRIPTION_LENGTH} characters",
            details={"field": "description"},
        )
    return text


@dataclass(frozen=True, slots=True)
class ProjectChanges:
    name: str | None = None
    description: str | None = None
    archived: bool | None = None


class ProjectService:
    def __init__(
        self,
        *,
        db: Database,
        clock: Clock,
        authz: AuthorizationService,
        audit: AuditLog,
    ) -> None:
        self._db = db
        self._clock = clock
        self._authz = authz
        self._audit = audit

    async def page(
        self,
        principal: Principal,
        org_id: uuid.UUID,
        *,
        include_archived: bool,
        cursor: str | None,
        limit: int | None,
    ) -> Page[Project]:
        """Projects the caller may read, newest first."""
        size = clamp_limit(limit)
        after = Cursor.decode(cursor) if cursor else None
        readable = await self._authz.readable_projects(principal, org_id)
        async with self._db.read() as session:
            rows = await ProjectRepository(session).page(
                org_id,
                include_archived=include_archived,
                limit=size,
                after=after,
                only_ids=readable,
            )
        items = rows[:size]
        next_cursor = None
        if len(rows) > size:
            last = items[-1]
            next_cursor = Cursor(created_at=last.created_at, id=str(last.id)).encode()
        return Page(items=items, next_cursor=next_cursor)

    async def get(self, org_id: uuid.UUID, project_id: uuid.UUID) -> Project:
        async with self._db.read() as session:
            project = await ProjectRepository(session).get(org_id, project_id)
        if project is None:
            raise NotFoundError("project")
        return project

    async def create(
        self, principal: Principal, org_id: uuid.UUID, *, name: str, description: str
    ) -> Project:
        project_name = clean_project_name(name)
        text = clean_description(description)
        async with self._db.transaction() as session:
            project = await ProjectRepository(session).add(
                org_id=org_id,
                name=project_name,
                description=text,
                created_by=principal.user_id,
                now=self._clock.now(),
            )
            await self._audit.record(
                session,
                Actor.of(principal),
                org_id=org_id,
                action=AuditAction.PROJECT_CREATED,
                target_type="project",
                target_id=project.id,
                data={"name": project.name},
            )
        return project

    async def update(
        self,
        principal: Principal,
        org_id: uuid.UUID,
        project_id: uuid.UUID,
        changes: ProjectChanges,
    ) -> Project:
        async with self._db.transaction() as session:
            repo = ProjectRepository(session)
            project = await repo.get(org_id, project_id, for_update=True)
            if project is None:
                raise NotFoundError("project")
            now = self._clock.now()
            name = clean_project_name(changes.name) if changes.name is not None else project.name
            text = (
                clean_description(changes.description)
                if changes.description is not None
                else project.description
            )
            was_archived = project.archived_at is not None
            archived_at = project.archived_at
            if changes.archived is True and not was_archived:
                archived_at = now
            elif changes.archived is False:
                archived_at = None

            diff: dict[str, object] = {}
            if name != project.name:
                diff["name"] = {"from": project.name, "to": name}
            if text != project.description:
                diff["description_changed"] = True
            await repo.update(
                project, name=name, description=text, archived_at=archived_at, now=now
            )
            actor = Actor.of(principal)
            if diff:
                await self._audit.record(
                    session,
                    actor,
                    org_id=org_id,
                    action=AuditAction.PROJECT_UPDATED,
                    target_type="project",
                    target_id=project.id,
                    data=diff,
                )
            is_archived = archived_at is not None
            if is_archived != was_archived:
                await self._audit.record(
                    session,
                    actor,
                    org_id=org_id,
                    action=(
                        AuditAction.PROJECT_ARCHIVED
                        if is_archived
                        else AuditAction.PROJECT_RESTORED
                    ),
                    target_type="project",
                    target_id=project.id,
                )
        return project

    async def delete(self, principal: Principal, org_id: uuid.UUID, project_id: uuid.UUID) -> None:
        async with self._db.transaction() as session:
            repo = ProjectRepository(session)
            project = await repo.get(org_id, project_id, for_update=True)
            if project is None:
                raise NotFoundError("project")
            await repo.delete(project)
            await self._audit.record(
                session,
                Actor.of(principal),
                org_id=org_id,
                action=AuditAction.PROJECT_DELETED,
                target_type="project",
                target_id=project.id,
                data={"name": project.name},
            )
