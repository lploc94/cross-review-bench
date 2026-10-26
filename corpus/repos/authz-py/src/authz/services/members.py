"""Members of an organisation and their role assignments."""

from __future__ import annotations

import uuid
from dataclasses import dataclass

from sqlalchemy.ext.asyncio import AsyncSession

from authz.domain.pagination import Cursor, Page, clamp_limit
from authz.domain.permissions import BuiltinRole, Permission
from authz.domain.principal import Actor, Principal, Resource
from authz.errors import ConflictError, NotFoundError
from authz.infra.clock import Clock
from authz.infra.db import Database
from authz.models import Membership, Role, RoleAssignment
from authz.repositories.organizations import (
    MemberRow,
    MembershipRepository,
    OrganizationRepository,
)
from authz.repositories.projects import ProjectRepository
from authz.repositories.roles import RoleAssignmentRepository, RoleRepository
from authz.services.audit import AuditAction, AuditLog
from authz.services.authorization import AuthorizationService, ensure_can_grant

LAST_OWNER = "an organisation must keep at least one owner"


@dataclass(frozen=True, slots=True)
class AssignmentRequest:
    user_id: uuid.UUID
    role_id: uuid.UUID
    project_id: uuid.UUID | None = None


class MemberService:
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
        self, org_id: uuid.UUID, *, cursor: str | None, limit: int | None
    ) -> Page[MemberRow]:
        size = clamp_limit(limit)
        after = Cursor.decode(cursor) if cursor else None
        async with self._db.read() as session:
            rows = await MembershipRepository(session).list_members(org_id, limit=size, after=after)
        items = rows[:size]
        next_cursor = None
        if len(rows) > size:
            last = items[-1].membership
            next_cursor = Cursor(created_at=last.created_at, id=str(last.id)).encode()
        return Page(items=items, next_cursor=next_cursor)

    async def membership(self, org_id: uuid.UUID, user_id: uuid.UUID) -> Membership | None:
        async with self._db.read() as session:
            return await MembershipRepository(session).get(org_id, user_id)

    async def get(self, org_id: uuid.UUID, user_id: uuid.UUID) -> MemberRow:
        async with self._db.read() as session:
            row = await MembershipRepository(session).get_member(org_id, user_id)
        if row is None:
            raise NotFoundError("member")
        return row

    async def change_role(
        self,
        principal: Principal,
        org_id: uuid.UUID,
        user_id: uuid.UUID,
        role_id: uuid.UUID,
    ) -> MemberRow:
        """Give a member another organisation-wide role.

        The caller must hold every permission of both the old and the new role, so nobody can
        promote someone above themselves or demote someone who outranks them.
        """
        async with self._db.transaction() as session:
            await self._lock_org(session, org_id)
            memberships = MembershipRepository(session)
            membership = await memberships.get(org_id, user_id)
            if membership is None:
                raise NotFoundError("member")
            roles = RoleRepository(session)
            new_role = await roles.get(org_id, role_id)
            if new_role is None:
                raise NotFoundError("role")
            old_role_id = membership.role_id
            if old_role_id != new_role.id:
                snapshot = await self._authz.snapshot(session, org_id, principal.user_id)
                ensure_can_grant(snapshot, org_id, old_role_id, action="take away")
                ensure_can_grant(snapshot, org_id, new_role.id, action="grant")
                await self._ensure_owner_remains(session, org_id, old_role_id, new_role)
                await memberships.set_role(membership, new_role.id, self._clock.now())
                await self._audit.record(
                    session,
                    Actor.of(principal),
                    org_id=org_id,
                    action=AuditAction.MEMBER_ROLE_CHANGED,
                    target_type="user",
                    target_id=user_id,
                    data={"from_role_id": old_role_id, "to_role_id": new_role.id},
                )
            row = await memberships.get_member(org_id, user_id)
        if row is None:
            raise NotFoundError("member")
        return row

    async def remove(self, principal: Principal, org_id: uuid.UUID, user_id: uuid.UUID) -> None:
        """Remove a member. Members may always leave; removing others needs members:manage."""
        leaving = user_id == principal.user_id
        if not leaving:
            await self._authz.enforce(principal, Permission.MEMBERS_MANAGE, Resource(org_id=org_id))
        async with self._db.transaction() as session:
            await self._lock_org(session, org_id)
            memberships = MembershipRepository(session)
            membership = await memberships.get(org_id, user_id)
            if membership is None:
                raise NotFoundError("member")
            if not leaving:
                snapshot = await self._authz.snapshot(session, org_id, principal.user_id)
                ensure_can_grant(snapshot, org_id, membership.role_id, action="take away")
            await self._ensure_owner_remains(session, org_id, membership.role_id, None)
            await memberships.remove(membership)
            await self._audit.record(
                session,
                Actor.of(principal),
                org_id=org_id,
                action=AuditAction.MEMBER_REMOVED,
                target_type="user",
                target_id=user_id,
                data={"role_id": membership.role_id, "left": leaving},
            )

    async def list_assignments(
        self,
        org_id: uuid.UUID,
        *,
        user_id: uuid.UUID | None = None,
        project_id: uuid.UUID | None = None,
    ) -> list[RoleAssignment]:
        async with self._db.read() as session:
            return await RoleAssignmentRepository(session).find(
                org_id, user_id=user_id, project_id=project_id
            )

    async def assign(
        self, principal: Principal, org_id: uuid.UUID, request: AssignmentRequest
    ) -> RoleAssignment:
        async with self._db.transaction() as session:
            membership = await MembershipRepository(session).get(org_id, request.user_id)
            if membership is None:
                raise NotFoundError("member")
            role = await RoleRepository(session).get(org_id, request.role_id)
            if role is None:
                raise NotFoundError("role")
            if request.project_id is not None and not await ProjectRepository(session).exists(
                org_id, request.project_id
            ):
                raise NotFoundError("project")
            snapshot = await self._authz.snapshot(session, org_id, principal.user_id)
            ensure_can_grant(snapshot, org_id, role.id, action="grant")
            assignment = await RoleAssignmentRepository(session).add(
                org_id=org_id,
                user_id=request.user_id,
                role_id=role.id,
                project_id=request.project_id,
                created_by=principal.user_id,
                now=self._clock.now(),
            )
            await self._audit.record(
                session,
                Actor.of(principal),
                org_id=org_id,
                action=AuditAction.ROLE_ASSIGNED,
                target_type="role_assignment",
                target_id=assignment.id,
                data={
                    "user_id": request.user_id,
                    "role_id": role.id,
                    "project_id": request.project_id,
                },
            )
        return assignment

    async def unassign(
        self, principal: Principal, org_id: uuid.UUID, assignment_id: uuid.UUID
    ) -> None:
        async with self._db.transaction() as session:
            repo = RoleAssignmentRepository(session)
            assignment = await repo.get(org_id, assignment_id)
            if assignment is None:
                raise NotFoundError("role assignment")
            snapshot = await self._authz.snapshot(session, org_id, principal.user_id)
            ensure_can_grant(snapshot, org_id, assignment.role_id, action="take away")
            await repo.remove(assignment)
            await self._audit.record(
                session,
                Actor.of(principal),
                org_id=org_id,
                action=AuditAction.ROLE_UNASSIGNED,
                target_type="role_assignment",
                target_id=assignment.id,
                data={
                    "user_id": assignment.user_id,
                    "role_id": assignment.role_id,
                    "project_id": assignment.project_id,
                },
            )

    @staticmethod
    async def _lock_org(session: AsyncSession, org_id: uuid.UUID) -> None:
        if await OrganizationRepository(session).lock(org_id) is None:
            raise NotFoundError("organization")

    @staticmethod
    async def _ensure_owner_remains(
        session: AsyncSession, org_id: uuid.UUID, old_role_id: uuid.UUID, new_role: Role | None
    ) -> None:
        """Refuse a change that would leave the organisation without an owner.

        Callers hold the organisation lock, so two concurrent demotions cannot both pass.
        """
        owner = await RoleRepository(session).get_by_name(org_id, BuiltinRole.OWNER.value)
        if owner is None or old_role_id != owner.id:
            return
        if new_role is not None and new_role.id == owner.id:
            return
        if await MembershipRepository(session).count_with_role(org_id, owner.id) <= 1:
            raise ConflictError(LAST_OWNER)
