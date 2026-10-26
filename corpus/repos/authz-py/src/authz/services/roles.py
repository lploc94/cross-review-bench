"""Built-in and custom roles."""

from __future__ import annotations

import re
import uuid
from dataclasses import dataclass
from datetime import datetime

from sqlalchemy.ext.asyncio import AsyncSession

from authz.domain.permissions import (
    BUILTIN_ROLE_NAMES,
    BUILTIN_ROLES,
    BuiltinRole,
    parse_permissions,
)
from authz.domain.policy import RoleNode, effective_permissions, would_create_cycle
from authz.domain.principal import Actor, Principal
from authz.errors import ConflictError, InvalidInputError, NotFoundError
from authz.infra.clock import Clock
from authz.infra.db import Database
from authz.models import Role
from authz.repositories.roles import RoleRepository
from authz.services.audit import AuditAction, AuditLog
from authz.services.authorization import (
    AuthorizationService,
    ensure_can_grant,
    ensure_holds_all,
)

ROLE_NAME = re.compile(r"^[a-z][a-z0-9_-]{1,49}$")
MAX_DESCRIPTION_LENGTH = 500


@dataclass(frozen=True, slots=True)
class RoleView:
    role: Role
    permissions: frozenset[str]
    effective_permissions: frozenset[str]


@dataclass(frozen=True, slots=True)
class RoleChanges:
    """A partial update; None leaves the field as it is."""

    name: str | None = None
    description: str | None = None
    permissions: list[str] | None = None
    parent_role_id: uuid.UUID | None = None
    clear_parent: bool = False


async def seed_builtin_roles(
    session: AsyncSession, org_id: uuid.UUID, now: datetime
) -> dict[BuiltinRole, Role]:
    """Create owner, admin, member and viewer for a new organisation, parents first."""
    roles = RoleRepository(session)
    created: dict[BuiltinRole, Role] = {}
    for template in BUILTIN_ROLES:
        parent = created[template.parent].id if template.parent else None
        created[template.name] = await roles.add(
            org_id=org_id,
            name=template.name.value,
            description=template.description,
            permissions=frozenset(p.value for p in template.permissions),
            parent_role_id=parent,
            builtin=True,
            now=now,
        )
    return created


def validate_role_name(name: str) -> str:
    candidate = name.strip().lower()
    if not ROLE_NAME.match(candidate):
        raise InvalidInputError(
            "role names are 2-50 characters: lower-case letters, digits, '-' and '_', "
            "starting with a letter",
            details={"field": "name"},
        )
    if candidate in BUILTIN_ROLE_NAMES:
        raise ConflictError(f"'{candidate}' is a built-in role", details={"field": "name"})
    return candidate


def validate_description(description: str) -> str:
    text = description.strip()
    if len(text) > MAX_DESCRIPTION_LENGTH:
        raise InvalidInputError(
            f"the description must have at most {MAX_DESCRIPTION_LENGTH} characters",
            details={"field": "description"},
        )
    return text


class RoleService:
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

    async def list_roles(self, org_id: uuid.UUID) -> list[RoleView]:
        async with self._db.read() as session:
            repo = RoleRepository(session)
            rows = await repo.list_with_permissions(org_id)
            graph = await repo.graph(org_id)
        return [
            RoleView(row.role, row.permissions, effective_permissions(graph, [row.role.id]))
            for row in rows
        ]

    async def get(self, org_id: uuid.UUID, role_id: uuid.UUID) -> RoleView:
        async with self._db.read() as session:
            repo = RoleRepository(session)
            role = await repo.get(org_id, role_id)
            if role is None:
                raise NotFoundError("role")
            graph = await repo.graph(org_id)
        node = graph[role.id]
        return RoleView(role, node.permissions, effective_permissions(graph, [role.id]))

    async def create(
        self,
        principal: Principal,
        org_id: uuid.UUID,
        *,
        name: str,
        description: str,
        permissions: list[str],
        parent_role_id: uuid.UUID | None,
    ) -> RoleView:
        role_name = validate_role_name(name)
        text = validate_description(description)
        granted = frozenset(p.value for p in parse_permissions(permissions))
        async with self._db.transaction() as session:
            repo = RoleRepository(session)
            graph = await repo.graph(org_id)
            if parent_role_id is not None and parent_role_id not in graph:
                raise NotFoundError("role", "the parent role does not exist")
            inherited = effective_permissions(graph, [parent_role_id]) if parent_role_id else None
            snapshot = await self._authz.snapshot(session, org_id, principal.user_id)
            ensure_holds_all(
                snapshot, org_id, granted | (inherited or frozenset()), action="create"
            )
            role = await repo.add(
                org_id=org_id,
                name=role_name,
                description=text,
                permissions=granted,
                parent_role_id=parent_role_id,
                builtin=False,
                now=self._clock.now(),
            )
            new_graph = {**graph, role.id: RoleNode(role.id, role.name, parent_role_id, granted)}
            await self._audit.record(
                session,
                Actor.of(principal),
                org_id=org_id,
                action=AuditAction.ROLE_CREATED,
                target_type="role",
                target_id=role.id,
                data={"name": role.name, "permissions": granted, "parent_role_id": parent_role_id},
            )
        return RoleView(role, granted, effective_permissions(new_graph, [role.id]))

    async def update(
        self,
        principal: Principal,
        org_id: uuid.UUID,
        role_id: uuid.UUID,
        changes: RoleChanges,
    ) -> RoleView:
        async with self._db.transaction() as session:
            repo = RoleRepository(session)
            role = await repo.get(org_id, role_id)
            if role is None:
                raise NotFoundError("role")
            if role.builtin:
                raise ConflictError("built-in roles cannot be changed")
            graph = await repo.graph(org_id)
            snapshot = await self._authz.snapshot(session, org_id, principal.user_id)
            ensure_can_grant(snapshot, org_id, role.id, action="change")

            current = graph[role.id]
            name = validate_role_name(changes.name) if changes.name is not None else role.name
            text = (
                validate_description(changes.description)
                if changes.description is not None
                else role.description
            )
            granted = (
                frozenset(p.value for p in parse_permissions(changes.permissions))
                if changes.permissions is not None
                else current.permissions
            )
            parent = None if changes.clear_parent else changes.parent_role_id or role.parent_role_id
            if parent is not None and parent not in graph:
                raise NotFoundError("role", "the parent role does not exist")
            if would_create_cycle(graph, role.id, parent):
                raise ConflictError(
                    "the parent role would make the role inherit from itself",
                    details={"field": "parent_role_id"},
                )

            new_graph = {**graph, role.id: RoleNode(role.id, name, parent, granted)}
            ensure_holds_all(
                snapshot, org_id, effective_permissions(new_graph, [role.id]), action="grant"
            )
            await repo.update(
                role, name=name, description=text, parent_role_id=parent, now=self._clock.now()
            )
            if granted != current.permissions:
                await repo.replace_permissions(role.id, granted)
            await self._audit.record(
                session,
                Actor.of(principal),
                org_id=org_id,
                action=AuditAction.ROLE_UPDATED,
                target_type="role",
                target_id=role.id,
                data=_diff(current, name, granted, parent),
            )
        return RoleView(role, granted, effective_permissions(new_graph, [role.id]))

    async def delete(self, principal: Principal, org_id: uuid.UUID, role_id: uuid.UUID) -> None:
        async with self._db.transaction() as session:
            repo = RoleRepository(session)
            role = await repo.get(org_id, role_id)
            if role is None:
                raise NotFoundError("role")
            if role.builtin:
                raise ConflictError("built-in roles cannot be deleted")
            snapshot = await self._authz.snapshot(session, org_id, principal.user_id)
            ensure_can_grant(snapshot, org_id, role.id, action="delete")
            usage = await repo.usage(role.id)
            if usage.in_use:
                raise ConflictError(
                    "the role is still in use",
                    details={
                        "memberships": usage.memberships,
                        "assignments": usage.assignments,
                        "invitations": usage.invitations,
                        "child_roles": usage.children,
                    },
                )
            await repo.delete(role)
            await self._audit.record(
                session,
                Actor.of(principal),
                org_id=org_id,
                action=AuditAction.ROLE_DELETED,
                target_type="role",
                target_id=role.id,
                data={"name": role.name},
            )


def _diff(
    before: RoleNode, name: str, permissions: frozenset[str], parent: uuid.UUID | None
) -> dict[str, object]:
    changes: dict[str, object] = {}
    if before.name != name:
        changes["name"] = {"from": before.name, "to": name}
    if before.permissions != permissions:
        changes["permissions_added"] = permissions - before.permissions
        changes["permissions_removed"] = before.permissions - permissions
    if before.parent_id != parent:
        changes["parent_role_id"] = {"from": before.parent_id, "to": parent}
    return changes
