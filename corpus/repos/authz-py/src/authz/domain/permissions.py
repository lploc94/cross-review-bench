"""The permission catalogue and the built-in roles every organisation starts with."""

from __future__ import annotations

import re
from dataclasses import dataclass
from enum import StrEnum

from authz.errors import InvalidInputError


class Permission(StrEnum):
    ORG_READ = "org:read"
    ORG_MANAGE = "org:manage"
    PROJECTS_READ = "projects:read"
    PROJECTS_WRITE = "projects:write"
    PROJECTS_DELETE = "projects:delete"
    MEMBERS_READ = "members:read"
    MEMBERS_MANAGE = "members:manage"
    ROLES_READ = "roles:read"
    ROLES_MANAGE = "roles:manage"
    INVITATIONS_MANAGE = "invitations:manage"
    AUDIT_READ = "audit:read"


PERMISSION_DESCRIPTIONS: dict[Permission, str] = {
    Permission.ORG_READ: "See the organisation's name and settings",
    Permission.ORG_MANAGE: "Rename the organisation and grant or revoke ownership",
    Permission.PROJECTS_READ: "List and read projects",
    Permission.PROJECTS_WRITE: "Create, edit and archive projects",
    Permission.PROJECTS_DELETE: "Delete projects",
    Permission.MEMBERS_READ: "List members and their roles",
    Permission.MEMBERS_MANAGE: "Change members' roles, assign roles and remove members",
    Permission.ROLES_READ: "List roles and their permissions",
    Permission.ROLES_MANAGE: "Create, edit and delete custom roles",
    Permission.INVITATIONS_MANAGE: "Invite people and list pending invitations",
    Permission.AUDIT_READ: "Read the audit log",
}

# Permissions that make sense on a single project; the others only apply organisation-wide.
PROJECT_SCOPED = frozenset(
    {Permission.PROJECTS_READ, Permission.PROJECTS_WRITE, Permission.PROJECTS_DELETE}
)

_PERMISSION_SHAPE = re.compile(r"^[a-z][a-z_]*:[a-z][a-z_]*$")


def parse_permission(value: str) -> Permission:
    """The catalogue entry for a permission string, or InvalidInputError."""
    candidate = value.strip()
    if not _PERMISSION_SHAPE.match(candidate):
        raise InvalidInputError(
            f"'{value}' is not a permission (expected resource:action)",
            details={"permission": value},
        )
    try:
        return Permission(candidate)
    except ValueError:
        raise InvalidInputError(
            f"unknown permission '{candidate}'", details={"permission": candidate}
        ) from None


def parse_permissions(values: list[str]) -> frozenset[Permission]:
    return frozenset(parse_permission(value) for value in values)


class BuiltinRole(StrEnum):
    OWNER = "owner"
    ADMIN = "admin"
    MEMBER = "member"
    VIEWER = "viewer"


@dataclass(frozen=True, slots=True)
class RoleTemplate:
    name: BuiltinRole
    description: str
    permissions: frozenset[Permission]
    parent: BuiltinRole | None


# Built-in roles inherit from each other: owner > admin > member > viewer.
BUILTIN_ROLES: tuple[RoleTemplate, ...] = (
    RoleTemplate(
        name=BuiltinRole.VIEWER,
        description="Read-only access to the organisation",
        permissions=frozenset(
            {
                Permission.ORG_READ,
                Permission.PROJECTS_READ,
                Permission.MEMBERS_READ,
                Permission.ROLES_READ,
            }
        ),
        parent=None,
    ),
    RoleTemplate(
        name=BuiltinRole.MEMBER,
        description="Works on projects",
        permissions=frozenset({Permission.PROJECTS_WRITE}),
        parent=BuiltinRole.VIEWER,
    ),
    RoleTemplate(
        name=BuiltinRole.ADMIN,
        description="Manages members, roles, invitations and projects",
        permissions=frozenset(
            {
                Permission.PROJECTS_DELETE,
                Permission.MEMBERS_MANAGE,
                Permission.ROLES_MANAGE,
                Permission.INVITATIONS_MANAGE,
                Permission.AUDIT_READ,
            }
        ),
        parent=BuiltinRole.MEMBER,
    ),
    RoleTemplate(
        name=BuiltinRole.OWNER,
        description="Full control, including ownership",
        permissions=frozenset({Permission.ORG_MANAGE}),
        parent=BuiltinRole.ADMIN,
    ),
)

BUILTIN_ROLE_NAMES = frozenset(role.name.value for role in BUILTIN_ROLES)


def builtin_effective_permissions(name: BuiltinRole) -> frozenset[Permission]:
    """Permissions of a built-in role including the ones it inherits."""
    by_name = {template.name: template for template in BUILTIN_ROLES}
    collected: set[Permission] = set()
    current: BuiltinRole | None = name
    while current is not None:
        template = by_name[current]
        collected |= template.permissions
        current = template.parent
    return frozenset(collected)
