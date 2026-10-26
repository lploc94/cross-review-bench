from __future__ import annotations

import uuid

from authz.domain.permissions import BuiltinRole, builtin_effective_permissions, parse_permission
from authz.domain.policy import (
    Grant,
    PolicySnapshot,
    RoleNode,
    ancestors,
    effective_permissions,
    would_create_cycle,
)
from authz.domain.principal import Resource

ORG = uuid.uuid4()
PROJECT = uuid.uuid4()


def node(name, parent=None, permissions=()):
    return RoleNode(uuid.uuid4(), name, parent.id if parent else None, frozenset(permissions))


def graph_of(*nodes):
    return {n.id: n for n in nodes}


def test_permissions_are_inherited_from_ancestors():
    base = node("base", permissions={"org:read"})
    middle = node("middle", base, {"projects:read"})
    top = node("top", middle, {"projects:write"})
    graph = graph_of(base, middle, top)

    assert ancestors(graph, top.id) == [top.id, middle.id, base.id]
    assert effective_permissions(graph, [top.id]) == {"org:read", "projects:read", "projects:write"}
    assert effective_permissions(graph, [base.id]) == {"org:read"}


def test_cycles_are_detected():
    a = node("a")
    b = node("b", a)
    c = node("c", b)
    graph = graph_of(a, b, c)

    assert would_create_cycle(graph, a.id, c.id)
    assert would_create_cycle(graph, a.id, a.id)
    assert not would_create_cycle(graph, c.id, a.id)
    assert not would_create_cycle(graph, a.id, None)


def test_expansion_stops_on_a_loop_in_stored_data():
    first_id, second_id = uuid.uuid4(), uuid.uuid4()
    graph = {
        first_id: RoleNode(first_id, "first", second_id, frozenset({"org:read"})),
        second_id: RoleNode(second_id, "second", first_id, frozenset({"audit:read"})),
    }

    assert effective_permissions(graph, [first_id]) == {"org:read", "audit:read"}


def test_project_grants_apply_only_to_their_project():
    viewer = node("viewer", permissions={"projects:read"})
    writer = node("writer", permissions={"projects:write"})
    snapshot = PolicySnapshot(
        graph=graph_of(viewer, writer),
        grants=(Grant(viewer.id), Grant(writer.id, PROJECT)),
    )

    assert "projects:write" in snapshot.permissions_on(Resource(ORG, PROJECT))
    assert "projects:write" not in snapshot.permissions_on(Resource(ORG, uuid.uuid4()))
    assert "projects:write" not in snapshot.org_permissions(ORG)
    assert snapshot.projects_with("projects:write") == {PROJECT}


def test_can_grant_only_roles_within_your_own_permissions():
    small = node("small", permissions={"projects:read"})
    big = node("big", small, {"members:manage"})
    snapshot = PolicySnapshot(graph=graph_of(small, big), grants=(Grant(small.id),))

    assert snapshot.can_grant(ORG, small.id)
    assert not snapshot.can_grant(ORG, big.id)


def test_builtin_roles_form_a_chain():
    viewer = builtin_effective_permissions(BuiltinRole.VIEWER)
    member = builtin_effective_permissions(BuiltinRole.MEMBER)
    admin = builtin_effective_permissions(BuiltinRole.ADMIN)
    owner = builtin_effective_permissions(BuiltinRole.OWNER)

    assert viewer < member < admin < owner
    assert parse_permission("org:manage") in owner - admin
