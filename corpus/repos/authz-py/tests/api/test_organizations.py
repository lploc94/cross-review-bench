from __future__ import annotations

from tests.helpers.factories import make_org, org_with_member, signed_in


async def test_creator_becomes_owner_with_builtin_roles(client, container):
    owner = await signed_in(client, container)

    org = await make_org(client, owner, "Acme Rockets")

    assert org["slug"] == "acme-rockets"
    detail = await client.get(f"/v1/orgs/{org['id']}", headers=owner.headers)
    assert detail.status_code == 200
    assert "org:manage" in detail.json()["permissions"]
    roles = await client.get(f"/v1/orgs/{org['id']}/roles", headers=owner.headers)
    names = {role["name"] for role in roles.json()["data"]}
    assert names == {"owner", "admin", "member", "viewer"}


async def test_lists_only_my_organizations_with_my_role(client, container):
    org, owner, viewer = await org_with_member(client, container, "viewer")
    await make_org(client, owner, "Second Org")

    response = await client.get("/v1/orgs", headers=viewer.headers)

    assert response.status_code == 200
    assert [(item["id"], item["role"]) for item in response.json()["data"]] == [
        (org["id"], "viewer")
    ]


async def test_non_members_get_404(client, container):
    owner = await signed_in(client, container)
    org = await make_org(client, owner)
    stranger = await signed_in(client, container)

    for path in ("", "/projects", "/members", "/roles", "/audit"):
        response = await client.get(f"/v1/orgs/{org['id']}{path}", headers=stranger.headers)
        assert response.status_code == 404, path
        assert response.json()["error"]["details"]["resource"] == "organization"


async def test_missing_org_looks_like_a_foreign_one(client, container):
    me = await signed_in(client, container)

    response = await client.get("/v1/orgs/00000000-0000-4000-8000-000000000000", headers=me.headers)

    assert response.status_code == 404


async def test_rename_requires_org_manage(client, container):
    org, owner, admin = await org_with_member(client, container, "admin")

    denied = await client.patch(
        f"/v1/orgs/{org['id']}", json={"name": "Hijacked"}, headers=admin.headers
    )
    allowed = await client.patch(
        f"/v1/orgs/{org['id']}", json={"name": "Acme Space"}, headers=owner.headers
    )

    assert denied.status_code == 403
    assert denied.json()["error"]["details"]["permission"] == "org:manage"
    assert allowed.status_code == 200
    assert allowed.json()["name"] == "Acme Space"


async def test_duplicate_slug_is_a_conflict(client, container):
    owner = await signed_in(client, container)
    await client.post("/v1/orgs", json={"name": "One", "slug": "taken"}, headers=owner.headers)

    response = await client.post(
        "/v1/orgs", json={"name": "Two", "slug": "taken"}, headers=owner.headers
    )

    assert response.status_code == 409


async def test_generated_slug_avoids_collisions(client, container):
    owner = await signed_in(client, container)
    first = await make_org(client, owner, "Northwind")
    second = await make_org(client, owner, "Northwind")

    assert first["slug"] == "northwind"
    assert second["slug"].startswith("northwind-")
    assert second["slug"] != first["slug"]
