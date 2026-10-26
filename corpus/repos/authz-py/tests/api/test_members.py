from __future__ import annotations

from tests.helpers.factories import add_member, make_org, org_with_member, role_id, signed_in


async def test_list_members_paginates_in_join_order(client, container, clock):
    owner = await signed_in(client, container)
    org = await make_org(client, owner)
    viewer = await signed_in(client, container)
    third = await signed_in(client, container)
    clock.advance(seconds=1)
    await add_member(container, org["id"], viewer, "viewer")
    clock.advance(seconds=1)
    await add_member(container, org["id"], third, "member")

    first_page = await client.get(
        f"/v1/orgs/{org['id']}/members", params={"limit": 2}, headers=viewer.headers
    )
    body = first_page.json()
    second_page = await client.get(
        f"/v1/orgs/{org['id']}/members",
        params={"limit": 2, "cursor": body["next_cursor"]},
        headers=viewer.headers,
    )

    assert first_page.status_code == 200
    assert [m["user_id"] for m in body["data"]] == [str(owner.id), str(viewer.id)]
    assert [m["user_id"] for m in second_page.json()["data"]] == [str(third.id)]
    assert second_page.json()["next_cursor"] is None


async def test_admin_changes_a_members_role(client, container):
    org, _, admin = await org_with_member(client, container, "admin")
    member = await signed_in(client, container)
    await add_member(container, org["id"], member, "viewer")
    member_role = await role_id(container, org["id"], "member")

    response = await client.patch(
        f"/v1/orgs/{org['id']}/members/{member.id}",
        json={"role_id": str(member_role)},
        headers=admin.headers,
    )

    assert response.status_code == 200
    assert response.json()["role"] == "member"


async def test_admin_cannot_promote_to_owner(client, container):
    org, _, admin = await org_with_member(client, container, "admin")
    owner_role = await role_id(container, org["id"], "owner")

    response = await client.patch(
        f"/v1/orgs/{org['id']}/members/{admin.id}",
        json={"role_id": str(owner_role)},
        headers=admin.headers,
    )

    assert response.status_code == 403
    assert response.json()["error"]["details"]["missing_permissions"] == ["org:manage"]


async def test_admin_cannot_demote_an_owner(client, container):
    org, owner, admin = await org_with_member(client, container, "admin")
    viewer_role = await role_id(container, org["id"], "viewer")

    response = await client.patch(
        f"/v1/orgs/{org['id']}/members/{owner.id}",
        json={"role_id": str(viewer_role)},
        headers=admin.headers,
    )

    assert response.status_code == 403


async def test_the_last_owner_cannot_be_demoted(client, container):
    org, owner, _ = await org_with_member(client, container, "viewer")
    admin_role = await role_id(container, org["id"], "admin")

    response = await client.patch(
        f"/v1/orgs/{org['id']}/members/{owner.id}",
        json={"role_id": str(admin_role)},
        headers=owner.headers,
    )

    assert response.status_code == 409
    assert "owner" in response.json()["error"]["message"]


async def test_an_owner_can_step_down_when_another_owner_exists(client, container):
    org, owner, co_owner = await org_with_member(client, container, "owner")
    admin_role = await role_id(container, org["id"], "admin")

    response = await client.patch(
        f"/v1/orgs/{org['id']}/members/{owner.id}",
        json={"role_id": str(admin_role)},
        headers=co_owner.headers,
    )

    assert response.status_code == 200
    assert response.json()["role"] == "admin"


async def test_members_can_leave(client, container):
    org, _, viewer = await org_with_member(client, container, "viewer")

    response = await client.delete(
        f"/v1/orgs/{org['id']}/members/{viewer.id}", headers=viewer.headers
    )

    assert response.status_code == 204
    assert (await client.get(f"/v1/orgs/{org['id']}", headers=viewer.headers)).status_code == 404


async def test_removing_others_requires_members_manage(client, container):
    org, owner, viewer = await org_with_member(client, container, "viewer")
    other = await signed_in(client, container)
    await add_member(container, org["id"], other, "viewer")

    denied = await client.delete(f"/v1/orgs/{org['id']}/members/{other.id}", headers=viewer.headers)
    allowed = await client.delete(f"/v1/orgs/{org['id']}/members/{other.id}", headers=owner.headers)

    assert denied.status_code == 403
    assert allowed.status_code == 204


async def test_the_last_owner_cannot_leave(client, container):
    org, owner, _ = await org_with_member(client, container, "admin")

    response = await client.delete(
        f"/v1/orgs/{org['id']}/members/{owner.id}", headers=owner.headers
    )

    assert response.status_code == 409
