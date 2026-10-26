"""Queries on roles, their permissions and role assignments."""

from __future__ import annotations

import uuid
from collections import defaultdict
from dataclasses import dataclass
from datetime import datetime
from typing import Any

from sqlalchemy import Select, delete, func, insert, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from authz.domain.policy import Grant, RoleNode
from authz.errors import ConflictError
from authz.models import Invitation, Membership, Role, RoleAssignment, RolePermission


@dataclass(frozen=True, slots=True)
class RoleWithPermissions:
    role: Role
    permissions: frozenset[str]


@dataclass(frozen=True, slots=True)
class RoleUsage:
    memberships: int
    assignments: int
    invitations: int
    children: int

    @property
    def in_use(self) -> bool:
        return any((self.memberships, self.assignments, self.invitations, self.children))


class RoleRepository:
    def __init__(self, session: AsyncSession) -> None:
        self._session = session

    async def add(
        self,
        *,
        org_id: uuid.UUID,
        name: str,
        description: str,
        permissions: frozenset[str],
        parent_role_id: uuid.UUID | None,
        builtin: bool,
        now: datetime,
    ) -> Role:
        role = Role(
            id=uuid.uuid4(),
            org_id=org_id,
            name=name,
            description=description,
            builtin=builtin,
            parent_role_id=parent_role_id,
            created_at=now,
            updated_at=now,
        )
        self._session.add(role)
        try:
            async with self._session.begin_nested():
                await self._session.flush()
        except IntegrityError:
            raise ConflictError(
                f"a role named '{name}' already exists", details={"field": "name"}
            ) from None
        await self.replace_permissions(role.id, permissions)
        return role

    async def get(self, org_id: uuid.UUID, role_id: uuid.UUID) -> Role | None:
        result = await self._session.execute(
            select(Role).where(Role.org_id == org_id, Role.id == role_id)
        )
        return result.scalar_one_or_none()

    async def get_by_name(self, org_id: uuid.UUID, name: str) -> Role | None:
        result = await self._session.execute(
            select(Role).where(Role.org_id == org_id, Role.name == name)
        )
        return result.scalar_one_or_none()

    async def permissions_of(self, role_id: uuid.UUID) -> frozenset[str]:
        result = await self._session.execute(
            select(RolePermission.permission).where(RolePermission.role_id == role_id)
        )
        return frozenset(result.scalars())

    async def list_with_permissions(self, org_id: uuid.UUID) -> list[RoleWithPermissions]:
        roles = (
            await self._session.execute(
                select(Role).where(Role.org_id == org_id).order_by(Role.builtin.desc(), Role.name)
            )
        ).scalars()
        grants = await self._permissions_by_role(org_id)
        return [RoleWithPermissions(role, grants.get(role.id, frozenset())) for role in roles]

    async def graph(self, org_id: uuid.UUID) -> dict[uuid.UUID, RoleNode]:
        """Every role of the organisation, for permission expansion and cycle checks."""
        rows = (
            await self._session.execute(
                select(Role.id, Role.name, Role.parent_role_id).where(Role.org_id == org_id)
            )
        ).all()
        grants = await self._permissions_by_role(org_id)
        return {
            role_id: RoleNode(role_id, name, parent_id, grants.get(role_id, frozenset()))
            for role_id, name, parent_id in rows
        }

    async def _permissions_by_role(self, org_id: uuid.UUID) -> dict[uuid.UUID, frozenset[str]]:
        result = await self._session.execute(
            select(RolePermission.role_id, RolePermission.permission)
            .join(Role, Role.id == RolePermission.role_id)
            .where(Role.org_id == org_id)
        )
        collected: dict[uuid.UUID, set[str]] = defaultdict(set)
        for role_id, permission in result:
            collected[role_id].add(permission)
        return {role_id: frozenset(values) for role_id, values in collected.items()}

    async def replace_permissions(self, role_id: uuid.UUID, permissions: frozenset[str]) -> None:
        await self._session.execute(delete(RolePermission).where(RolePermission.role_id == role_id))
        if permissions:
            await self._session.execute(
                insert(RolePermission),
                [{"role_id": role_id, "permission": p} for p in sorted(permissions)],
            )

    async def update(
        self,
        role: Role,
        *,
        name: str,
        description: str,
        parent_role_id: uuid.UUID | None,
        now: datetime,
    ) -> None:
        role.name = name
        role.description = description
        role.parent_role_id = parent_role_id
        role.updated_at = now
        try:
            async with self._session.begin_nested():
                await self._session.flush()
        except IntegrityError:
            raise ConflictError(
                f"a role named '{name}' already exists", details={"field": "name"}
            ) from None

    async def _count(self, query: Select[Any]) -> int:
        return int(await self._session.scalar(query) or 0)

    async def usage(self, role_id: uuid.UUID) -> RoleUsage:
        return RoleUsage(
            memberships=await self._count(
                select(func.count()).select_from(Membership).where(Membership.role_id == role_id)
            ),
            assignments=await self._count(
                select(func.count())
                .select_from(RoleAssignment)
                .where(RoleAssignment.role_id == role_id)
            ),
            invitations=await self._count(
                select(func.count())
                .select_from(Invitation)
                .where(Invitation.role_id == role_id, Invitation.accepted_at.is_(None))
            ),
            children=await self._count(
                select(func.count()).select_from(Role).where(Role.parent_role_id == role_id)
            ),
        )

    async def delete(self, role: Role) -> None:
        await self._session.delete(role)
        await self._session.flush()


class RoleAssignmentRepository:
    def __init__(self, session: AsyncSession) -> None:
        self._session = session

    async def add(
        self,
        *,
        org_id: uuid.UUID,
        user_id: uuid.UUID,
        role_id: uuid.UUID,
        project_id: uuid.UUID | None,
        created_by: uuid.UUID | None,
        now: datetime,
    ) -> RoleAssignment:
        assignment = RoleAssignment(
            id=uuid.uuid4(),
            org_id=org_id,
            user_id=user_id,
            role_id=role_id,
            project_id=project_id,
            created_by=created_by,
            created_at=now,
        )
        self._session.add(assignment)
        try:
            async with self._session.begin_nested():
                await self._session.flush()
        except IntegrityError:
            raise ConflictError("the member already has this role assignment") from None
        return assignment

    async def get(self, org_id: uuid.UUID, assignment_id: uuid.UUID) -> RoleAssignment | None:
        result = await self._session.execute(
            select(RoleAssignment).where(
                RoleAssignment.org_id == org_id, RoleAssignment.id == assignment_id
            )
        )
        return result.scalar_one_or_none()

    async def find(
        self,
        org_id: uuid.UUID,
        *,
        user_id: uuid.UUID | None = None,
        project_id: uuid.UUID | None = None,
    ) -> list[RoleAssignment]:
        query = select(RoleAssignment).where(RoleAssignment.org_id == org_id)
        if user_id is not None:
            query = query.where(RoleAssignment.user_id == user_id)
        if project_id is not None:
            query = query.where(RoleAssignment.project_id == project_id)
        result = await self._session.execute(
            query.order_by(RoleAssignment.created_at, RoleAssignment.id)
        )
        return list(result.scalars())

    async def for_member(self, org_id: uuid.UUID, user_id: uuid.UUID) -> list[RoleAssignment]:
        return await self.find(org_id, user_id=user_id)

    async def remove(self, assignment: RoleAssignment) -> None:
        await self._session.delete(assignment)
        await self._session.flush()

    async def grants_for(self, org_id: uuid.UUID, user_id: uuid.UUID) -> tuple[Grant, ...]:
        """The member's roles: the membership role first, then every assignment.

        Empty when the user is not a member; assignments cannot outlive the membership.
        """
        membership_role = await self._session.scalar(
            select(Membership.role_id).where(
                Membership.org_id == org_id, Membership.user_id == user_id
            )
        )
        if membership_role is None:
            return ()
        rows = await self._session.execute(
            select(RoleAssignment.role_id, RoleAssignment.project_id).where(
                RoleAssignment.org_id == org_id, RoleAssignment.user_id == user_id
            )
        )
        return (Grant(membership_role), *(Grant(role, project) for role, project in rows))
