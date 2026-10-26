from __future__ import annotations

from tests.helpers.factories import org_with_member, role_id


async def _project(client, org, owner, name="Apollo"):
    response = await client.post(
        f"/v1/orgs/{org['id']}/projects", json={"name": name}, headers=owner.headers
    )
    assert response.status_code == 201
    return response.json()


async def test_project_scoped_assignment_grants_access_to_that_project_only(client, container):
    org, owner, guest = await org_with_member(client, container, "viewer")
    # The guest's membership role carries no permissions of its own.
    nothing = await client.post(
        f"/v1/orgs/{org['id']}/roles", json={"name": "guest"}, headers=owner.headers
    )
    await client.patch(
        f"/v1/orgs/{org['id']}/members/{guest.id}",
        json={"role_id": nothing.json()["id"]},
        headers=owner.headers,
    )
    apollo = await _project(client, org, owner, "Apollo")
    gemini = await _project(client, org, owner, "Gemini")
    member_role = await role_id(container, org["id"], "member")

    assigned = await client.post(
        f"/v1/orgs/{org['id']}/role-assignments",
        json={"user_id": str(guest.id), "role_id": str(member_role), "project_id": apollo["id"]},
        headers=owner.headers,
    )

    assert assigned.status_code == 201
    base = f"/v1/orgs/{org['id']}/projects"
    assert (await client.get(f"{base}/{apollo['id']}", headers=guest.headers)).status_code == 200
    assert (await client.get(f"{base}/{gemini['id']}", headers=guest.headers)).status_code == 403
    edit = await client.patch(
        f"{base}/{apollo['id']}", json={"description": "Moon"}, headers=guest.headers
    )
    assert edit.status_code == 200
    listed = await client.get(base, headers=guest.headers)
    assert [p["id"] for p in listed.json()["data"]] == [apollo["id"]]
    create = await client.post(base, json={"name": "Mercury"}, headers=guest.headers)
    assert create.status_code == 403


async def test_duplicate_assignments_conflict(client, container):
    org, owner, viewer = await org_with_member(client, container, "viewer")
    member_role = await role_id(container, org["id"], "member")
    body = {"user_id": str(viewer.id), "role_id": str(member_role)}
    path = f"/v1/orgs/{org['id']}/role-assignments"

    first = await client.post(path, json=body, headers=owner.headers)
    second = await client.post(path, json=body, headers=owner.headers)

    assert first.status_code == 201
    assert second.status_code == 409


async def test_org_wide_assignment_adds_permissions_and_can_be_removed(client, container):
    org, owner, viewer = await org_with_member(client, container, "viewer")
    member_role = await role_id(container, org["id"], "member")
    path = f"/v1/orgs/{org['id']}/role-assignments"
    projects = f"/v1/orgs/{org['id']}/projects"
    assert (
        await client.post(projects, json={"name": "A"}, headers=viewer.headers)
    ).status_code == 403

    created = await client.post(
        path, json={"user_id": str(viewer.id), "role_id": str(member_role)}, headers=owner.headers
    )
    assert (
        await client.post(projects, json={"name": "B"}, headers=viewer.headers)
    ).status_code == 201
    listed = await client.get(path, params={"user_id": str(viewer.id)}, headers=owner.headers)
    assert [a["id"] for a in listed.json()["data"]] == [created.json()["id"]]

    removed = await client.delete(f"{path}/{created.json()['id']}", headers=owner.headers)

    assert removed.status_code == 204
    assert (
        await client.post(projects, json={"name": "C"}, headers=viewer.headers)
    ).status_code == 403


async def test_assignments_need_an_existing_member(client, container):
    org, owner, _ = await org_with_member(client, container, "viewer")
    member_role = await role_id(container, org["id"], "member")

    response = await client.post(
        f"/v1/orgs/{org['id']}/role-assignments",
        json={"user_id": "00000000-0000-4000-8000-000000000001", "role_id": str(member_role)},
        headers=owner.headers,
    )

    assert response.status_code == 404
    assert response.json()["error"]["details"]["resource"] == "member"
