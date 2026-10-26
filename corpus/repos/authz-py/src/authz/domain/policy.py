"""Role inheritance and permission evaluation, independent of storage.

A member's permissions on a resource come from the roles that apply to it: the membership's
organisation-wide role, every organisation-wide role assignment, and the assignments limited to
the project being checked. Each role contributes its own permissions and those of its ancestors.
"""

from __future__ import annotations

import uuid
from collections.abc import Iterable, Mapping
from dataclasses import dataclass

from authz.domain.principal import Resource


@dataclass(frozen=True, slots=True)
class RoleNode:
    """A role as the authorisation graph sees it: its own permissions and its parent."""

    id: uuid.UUID
    name: str
    parent_id: uuid.UUID | None
    permissions: frozenset[str]


@dataclass(frozen=True, slots=True)
class Grant:
    """A role held by a member, organisation-wide (project_id None) or on one project."""

    role_id: uuid.UUID
    project_id: uuid.UUID | None = None

    def applies_to(self, resource: Resource) -> bool:
        return self.project_id is None or self.project_id == resource.project_id


RoleGraph = Mapping[uuid.UUID, RoleNode]


def ancestors(graph: RoleGraph, role_id: uuid.UUID) -> list[uuid.UUID]:
    """The role followed by its parent chain. Stops at a repeated role instead of looping."""
    chain: list[uuid.UUID] = []
    seen: set[uuid.UUID] = set()
    current: uuid.UUID | None = role_id
    while current is not None and current not in seen and current in graph:
        seen.add(current)
        chain.append(current)
        current = graph[current].parent_id
    return chain


def effective_permissions(graph: RoleGraph, role_ids: Iterable[uuid.UUID]) -> frozenset[str]:
    collected: set[str] = set()
    for role_id in role_ids:
        for ancestor in ancestors(graph, role_id):
            collected |= graph[ancestor].permissions
    return frozenset(collected)


def would_create_cycle(
    graph: RoleGraph, role_id: uuid.UUID, new_parent_id: uuid.UUID | None
) -> bool:
    """True when making new_parent_id the parent of role_id closes a loop."""
    if new_parent_id is None:
        return False
    if new_parent_id == role_id:
        return True
    current: uuid.UUID | None = new_parent_id
    seen: set[uuid.UUID] = set()
    while current is not None and current not in seen:
        if current == role_id:
            return True
        seen.add(current)
        node = graph.get(current)
        current = node.parent_id if node else None
    return current is not None


@dataclass(frozen=True, slots=True)
class PolicySnapshot:
    """Everything needed to decide for one member of one organisation."""

    graph: RoleGraph
    grants: tuple[Grant, ...]

    @property
    def is_member(self) -> bool:
        return bool(self.grants)

    def permissions_on(self, resource: Resource) -> frozenset[str]:
        roles = [grant.role_id for grant in self.grants if grant.applies_to(resource)]
        return effective_permissions(self.graph, roles)

    def org_permissions(self, org_id: uuid.UUID) -> frozenset[str]:
        return self.permissions_on(Resource(org_id=org_id))

    def projects_with(self, permission: str) -> set[uuid.UUID]:
        """Projects on which a project-limited assignment grants the permission."""
        found: set[uuid.UUID] = set()
        for grant in self.grants:
            if grant.project_id is None:
                continue
            if permission in effective_permissions(self.graph, [grant.role_id]):
                found.add(grant.project_id)
        return found

    def role_permissions(self, role_id: uuid.UUID) -> frozenset[str]:
        return effective_permissions(self.graph, [role_id])

    def can_grant(self, org_id: uuid.UUID, role_id: uuid.UUID) -> bool:
        """A member may hand out a role only if they hold every permission it carries."""
        return self.role_permissions(role_id) <= self.org_permissions(org_id)
