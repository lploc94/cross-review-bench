from __future__ import annotations

from tests.helpers.clock import FrozenClock
from tests.helpers.factories import make_org, org_with_member, signed_in


async def test_member_creates_and_reads_projects(client, container):
    org, _, member = await org_with_member(client, container, "member")
    base = f"/v1/orgs/{org['id']}/projects"

    created = await client.post(
        base, json={"name": "  Apollo  ", "description": "Moon"}, headers=member.headers
    )

    assert created.status_code == 201
    project = created.json()
    assert project["name"] == "Apollo"
    assert project["created_by"] == str(member.id)
    fetched = await client.get(f"{base}/{project['id']}", headers=member.headers)
    assert fetched.json() == project


async def test_viewers_cannot_create_projects(client, container):
    org, _, viewer = await org_with_member(client, container, "viewer")

    response = await client.post(
        f"/v1/orgs/{org['id']}/projects", json={"name": "Nope"}, headers=viewer.headers
    )

    assert response.status_code == 403
    assert response.json()["error"]["code"] == "permission_denied"


async def test_project_names_are_unique_per_org(client, container):
    org, owner, _ = await org_with_member(client, container, "viewer")
    base = f"/v1/orgs/{org['id']}/projects"
    await client.post(base, json={"name": "Apollo"}, headers=owner.headers)

    response = await client.post(base, json={"name": "Apollo"}, headers=owner.headers)

    assert response.status_code == 409


async def test_archived_projects_are_hidden_unless_asked_for(client, container):
    org, owner, _ = await org_with_member(client, container, "viewer")
    base = f"/v1/orgs/{org['id']}/projects"
    project = (await client.post(base, json={"name": "Old"}, headers=owner.headers)).json()

    archived = await client.patch(
        f"{base}/{project['id']}", json={"archived": True}, headers=owner.headers
    )

    assert archived.status_code == 200
    assert archived.json()["archived_at"] is not None
    assert (await client.get(base, headers=owner.headers)).json()["data"] == []
    with_archived = await client.get(
        base, params={"include_archived": "true"}, headers=owner.headers
    )
    assert [p["id"] for p in with_archived.json()["data"]] == [project["id"]]


async def test_deleting_requires_projects_delete(client, container):
    org, owner, member = await org_with_member(client, container, "member")
    base = f"/v1/orgs/{org['id']}/projects"
    project = (await client.post(base, json={"name": "Temp"}, headers=member.headers)).json()

    denied = await client.delete(f"{base}/{project['id']}", headers=member.headers)
    allowed = await client.delete(f"{base}/{project['id']}", headers=owner.headers)

    assert denied.status_code == 403
    assert allowed.status_code == 204
    assert (await client.get(f"{base}/{project['id']}", headers=owner.headers)).status_code == 404


async def test_projects_of_another_org_are_not_found(client, container):
    owner = await signed_in(client, container)
    first = await make_org(client, owner, "First")
    second = await make_org(client, owner, "Second")
    project = (
        await client.post(
            f"/v1/orgs/{first['id']}/projects", json={"name": "Apollo"}, headers=owner.headers
        )
    ).json()

    response = await client.get(
        f"/v1/orgs/{second['id']}/projects/{project['id']}", headers=owner.headers
    )

    assert response.status_code == 404
    assert response.json()["error"]["details"]["resource"] == "project"


async def test_projects_are_listed_newest_first_with_a_cursor(
    client, container, clock: FrozenClock
):
    org, owner, _ = await org_with_member(client, container, "viewer")
    base = f"/v1/orgs/{org['id']}/projects"
    ids = []
    for name in ("One", "Two", "Three"):
        clock.advance(seconds=1)
        ids.append(
            (await client.post(base, json={"name": name}, headers=owner.headers)).json()["id"]
        )

    first = (await client.get(base, params={"limit": 2}, headers=owner.headers)).json()
    second = (
        await client.get(
            base, params={"limit": 2, "cursor": first["next_cursor"]}, headers=owner.headers
        )
    ).json()

    assert [p["id"] for p in first["data"]] == [ids[2], ids[1]]
    assert [p["id"] for p in second["data"]] == [ids[0]]
    assert second["next_cursor"] is None


async def test_empty_update_is_rejected(client, container):
    org, owner, _ = await org_with_member(client, container, "viewer")
    base = f"/v1/orgs/{org['id']}/projects"
    project = (await client.post(base, json={"name": "Apollo"}, headers=owner.headers)).json()

    response = await client.patch(f"{base}/{project['id']}", json={}, headers=owner.headers)

    assert response.status_code == 422
