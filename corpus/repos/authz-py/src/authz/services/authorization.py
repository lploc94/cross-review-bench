"""The single place where access decisions are made."""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from enum import StrEnum

from sqlalchemy.ext.asyncio import AsyncSession

from authz.domain.permissions import Permission
from authz.domain.policy import PolicySnapshot
from authz.domain.principal import Principal, Resource
from authz.errors import PermissionDenied
from authz.infra.db import Database
from authz.logging import get_logger
from authz.repositories.roles import RoleAssignmentRepository, RoleRepository

log = get_logger(__name__)


class DecisionReason(StrEnum):
    GRANTED = "granted"
    NOT_A_MEMBER = "not_a_member"
    MISSING_PERMISSION = "missing_permission"


@dataclass(frozen=True, slots=True)
class Decision:
    allowed: bool
    permission: str
    resource: Resource
    reason: DecisionReason


class AuthorizationService:
    """Decides whether a principal holds a permission on a resource.

    Every check goes through `check`; the FastAPI dependency `require` and the services that
    need finer rules (who may hand out which role) build on it and on `snapshot`.
    """

    def __init__(self, db: Database) -> None:
        self._db = db

    async def snapshot(
        self, session: AsyncSession, org_id: uuid.UUID, user_id: uuid.UUID
    ) -> PolicySnapshot:
        """The member's roles and the organisation's role graph, read in the given session."""
        grants = await RoleAssignmentRepository(session).grants_for(org_id, user_id)
        if not grants:
            return PolicySnapshot(graph={}, grants=())
        graph = await RoleRepository(session).graph(org_id)
        return PolicySnapshot(graph=graph, grants=grants)

    async def _load(self, principal: Principal, org_id: uuid.UUID) -> PolicySnapshot:
        async with self._db.read() as session:
            return await self.snapshot(session, org_id, principal.user_id)

    @staticmethod
    def decide(
        snapshot: PolicySnapshot, permission: Permission | str, resource: Resource
    ) -> Decision:
        name = str(permission)
        if not snapshot.is_member:
            return Decision(False, name, resource, DecisionReason.NOT_A_MEMBER)
        if name in snapshot.permissions_on(resource):
            return Decision(True, name, resource, DecisionReason.GRANTED)
        return Decision(False, name, resource, DecisionReason.MISSING_PERMISSION)

    async def check(
        self, principal: Principal, permission: Permission | str, resource: Resource
    ) -> Decision:
        snapshot = await self._load(principal, resource.org_id)
        decision = self.decide(snapshot, permission, resource)
        if not decision.allowed:
            log.info(
                "authz.denied",
                user_id=str(principal.user_id),
                permission=decision.permission,
                resource=resource.describe(),
                reason=decision.reason.value,
            )
        return decision

    async def enforce(
        self, principal: Principal, permission: Permission | str, resource: Resource
    ) -> None:
        decision = await self.check(principal, permission, resource)
        if not decision.allowed:
            raise PermissionDenied(
                f"missing permission {decision.permission}",
                details={"permission": decision.permission},
            )

    async def permissions(self, principal: Principal, resource: Resource) -> frozenset[str]:
        snapshot = await self._load(principal, resource.org_id)
        return snapshot.permissions_on(resource)

    async def readable_projects(
        self, principal: Principal, org_id: uuid.UUID
    ) -> set[uuid.UUID] | None:
        """None when the principal may read every project, else the projects it may read."""
        snapshot = await self._load(principal, org_id)
        if Permission.PROJECTS_READ in snapshot.org_permissions(org_id):
            return None
        return snapshot.projects_with(Permission.PROJECTS_READ)


def ensure_can_grant(
    snapshot: PolicySnapshot, org_id: uuid.UUID, role_id: uuid.UUID, *, action: str
) -> None:
    """Refuse to hand out (or take away) a role carrying permissions the caller lacks."""
    ensure_holds_all(snapshot, org_id, snapshot.role_permissions(role_id), action=action)


def ensure_holds_all(
    snapshot: PolicySnapshot, org_id: uuid.UUID, permissions: frozenset[str], *, action: str
) -> None:
    missing = sorted(permissions - snapshot.org_permissions(org_id))
    if missing:
        raise PermissionDenied(
            f"you cannot {action} a role with permissions you do not hold",
            details={"missing_permissions": missing},
        )
