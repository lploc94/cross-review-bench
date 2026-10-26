from __future__ import annotations

from authz.domain.principal import Actor, Principal, Resource
from authz.services.authorization import DecisionReason
from tests.helpers.factories import add_member, make_user


async def _setup(container, role):
    owner = await make_user(container)
    created = await container.organizations.create(owner.id, name="Globex", actor=Actor.system())
    org = created.organization
    user = await make_user(container)
    await add_member(container, org.id, user, role)
    return org, Principal.user(user.id, None)


async def test_member_permissions_follow_the_role(container):
    org, viewer = await _setup(container, "viewer")
    resource = Resource(org_id=org.id)

    read = await container.authz.check(viewer, "projects:read", resource)
    write = await container.authz.check(viewer, "projects:write", resource)

    assert read.allowed
    assert read.reason is DecisionReason.GRANTED
    assert not write.allowed
    assert write.reason is DecisionReason.MISSING_PERMISSION


async def test_non_members_are_denied(container):
    org, _ = await _setup(container, "viewer")
    stranger = Principal.user((await make_user(container)).id, None)

    decision = await container.authz.check(stranger, "org:read", Resource(org_id=org.id))

    assert not decision.allowed
    assert decision.reason is DecisionReason.NOT_A_MEMBER


async def test_permissions_of_the_owner_include_everything(container):
    org, owner_principal = await _setup(container, "owner")

    permissions = await container.authz.permissions(owner_principal, Resource(org_id=org.id))

    assert {"org:manage", "audit:read", "members:manage", "projects:delete"} <= permissions


async def test_readable_projects_is_none_with_org_wide_read(container):
    org, viewer = await _setup(container, "viewer")

    assert await container.authz.readable_projects(viewer, org.id) is None
