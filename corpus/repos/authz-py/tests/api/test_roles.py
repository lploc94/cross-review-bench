from __future__ import annotations

from tests.helpers.factories import add_member, org_with_member, role_id, signed_in


async def test_builtin_roles_inherit_permissions(client, container):
    org, owner, _ = await org_with_member(client, container, "viewer")

    response = await client.get(f"/v1/orgs/{org['id']}/roles", headers=owner.headers)

    roles = {role["name"]: role for role in response.json()["data"]}
    assert roles["member"]["permissions"] == ["projects:write"]
    assert set(roles["viewer"]["effective_permissions"]) < set(
        roles["member"]["effective_permissions"]
    )
    assert "org:manage" in roles["owner"]["effective_permissions"]
    assert "org:manage" not in roles["admin"]["effective_permissions"]
    assert all(role["builtin"] for role in roles.values())


async def test_create_custom_role_with_parent(client, container):
    org, owner, _ = await org_with_member(client, container, "viewer")
    viewer_role = await role_id(container, org["id"], "viewer")

    response = await client.post(
        f"/v1/orgs/{org['id']}/roles",
        json={
            "name": "auditor",
            "description": "Reads the audit log",
            "permissions": ["audit:read"],
            "parent_role_id": str(viewer_role),
        },
        headers=owner.headers,
    )

    assert response.status_code == 201
    body = response.json()
    assert body["permissions"] == ["audit:read"]
    assert {"audit:read", "projects:read", "org:read"} <= set(body["effective_permissions"])
    assert body["builtin"] is False


async def test_unknown_permissions_are_rejected(client, container):
    org, owner, _ = await org_with_member(client, container, "viewer")

    response = await client.post(
        f"/v1/orgs/{org['id']}/roles",
        json={"name": "weird", "permissions": ["projects:fly"]},
        headers=owner.headers,
    )

    assert response.status_code == 422
    assert response.json()["error"]["details"]["permission"] == "projects:fly"


async def test_role_names_cannot_shadow_builtin_roles(client, container):
    org, owner, _ = await org_with_member(client, container, "viewer")

    response = await client.post(
        f"/v1/orgs/{org['id']}/roles", json={"name": "Admin"}, headers=owner.headers
    )

    assert response.status_code == 409


async def test_inheritance_cycles_are_rejected(client, container):
    org, owner, _ = await org_with_member(client, container, "viewer")
    base = f"/v1/orgs/{org['id']}/roles"
    first = (await client.post(base, json={"name": "first"}, headers=owner.headers)).json()
    second = (
        await client.post(
            base, json={"name": "second", "parent_role_id": first["id"]}, headers=owner.headers
        )
    ).json()

    response = await client.patch(
        f"{base}/{first['id']}", json={"parent_role_id": second["id"]}, headers=owner.headers
    )
    itself = await client.patch(
        f"{base}/{first['id']}", json={"parent_role_id": first["id"]}, headers=owner.headers
    )

    assert response.status_code == 409
    assert response.json()["error"]["details"]["field"] == "parent_role_id"
    assert itself.status_code == 409


async def test_parent_can_be_removed(client, container):
    org, owner, _ = await org_with_member(client, container, "viewer")
    viewer_role = await role_id(container, org["id"], "viewer")
    base = f"/v1/orgs/{org['id']}/roles"
    created = await client.post(
        base, json={"name": "reader", "parent_role_id": str(viewer_role)}, headers=owner.headers
    )

    response = await client.patch(
        f"{base}/{created.json()['id']}", json={"parent_role_id": None}, headers=owner.headers
    )

    assert response.status_code == 200
    assert response.json()["parent_role_id"] is None
    assert response.json()["effective_permissions"] == []


async def test_builtin_roles_cannot_be_changed_or_deleted(client, container):
    org, owner, _ = await org_with_member(client, container, "viewer")
    viewer_role = await role_id(container, org["id"], "viewer")
    path = f"/v1/orgs/{org['id']}/roles/{viewer_role}"

    changed = await client.patch(path, json={"permissions": []}, headers=owner.headers)
    deleted = await client.delete(path, headers=owner.headers)

    assert changed.status_code == 409
    assert deleted.status_code == 409


async def test_roles_in_use_cannot_be_deleted(client, container):
    org, owner, _ = await org_with_member(client, container, "viewer")
    created = await client.post(
        f"/v1/orgs/{org['id']}/roles",
        json={"name": "contractor", "permissions": ["projects:read"]},
        headers=owner.headers,
    )
    role = created.json()
    contractor = await signed_in(client, container)
    await add_member(container, org["id"], contractor, "contractor")

    in_use = await client.delete(f"/v1/orgs/{org['id']}/roles/{role['id']}", headers=owner.headers)
    await client.delete(f"/v1/orgs/{org['id']}/members/{contractor.id}", headers=owner.headers)
    unused = await client.delete(f"/v1/orgs/{org['id']}/roles/{role['id']}", headers=owner.headers)

    assert in_use.status_code == 409
    assert in_use.json()["error"]["details"]["memberships"] == 1
    assert unused.status_code == 204


async def test_cannot_create_a_role_with_permissions_you_lack(client, container):
    org, _, admin = await org_with_member(client, container, "admin")

    response = await client.post(
        f"/v1/orgs/{org['id']}/roles",
        json={"name": "superuser", "permissions": ["org:manage"]},
        headers=admin.headers,
    )

    assert response.status_code == 403
    assert response.json()["error"]["details"]["missing_permissions"] == ["org:manage"]


async def test_viewers_cannot_manage_roles(client, container):
    org, _, viewer = await org_with_member(client, container, "viewer")

    response = await client.post(
        f"/v1/orgs/{org['id']}/roles", json={"name": "mine"}, headers=viewer.headers
    )

    assert response.status_code == 403


async def test_permission_catalogue(client, container):
    me = await signed_in(client, container)

    response = await client.get("/v1/permissions", headers=me.headers)

    catalogue = {item["name"]: item for item in response.json()["data"]}
    assert catalogue["projects:write"]["project_scoped"] is True
    assert catalogue["members:manage"]["project_scoped"] is False
