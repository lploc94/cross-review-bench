from __future__ import annotations

from tests.helpers.factories import bearer, make_org, role_id, signed_in


async def _key_for(client, container, org, creator, role="member"):
    rid = await role_id(container, org["id"], role)
    response = await client.post(
        f"/v1/orgs/{org['id']}/api-keys",
        json={"name": "Nightly sync", "role_id": str(rid)},
        headers=creator.headers,
    )
    assert response.status_code == 201, response.text
    return bearer(response.json()["key"])


async def test_key_of_one_organisation_cannot_reach_another(client, container):
    olive = await signed_in(client, container, name="Olive Owner")
    acme = await make_org(client, olive, "Acme Rockets")
    globex = await make_org(client, olive, "Globex Labs")
    secret_project = await client.post(
        f"/v1/orgs/{globex['id']}/projects", json={"name": "Hyperion"}, headers=olive.headers
    )
    assert secret_project.status_code == 201
    key = await _key_for(client, container, acme, olive)
    acme_projects = f"/v1/orgs/{acme['id']}/projects"
    globex_projects = f"/v1/orgs/{globex['id']}/projects"
    assert (await client.get(acme_projects, headers=key)).status_code == 200

    read = await client.get(f"{globex_projects}/{secret_project.json()['id']}", headers=key)
    edit = await client.patch(
        f"{globex_projects}/{secret_project.json()['id']}",
        json={"description": "changed"},
        headers=key,
    )
    write = await client.post(globex_projects, json={"name": "Intruder"}, headers=key)
    listed = await client.get(globex_projects, headers=key)
    org = await client.get(f"/v1/orgs/{globex['id']}", headers=key)

    assert read.status_code in (403, 404)
    assert edit.status_code in (403, 404)
    assert write.status_code in (403, 404)
    assert org.status_code in (403, 404)
    assert listed.status_code in (403, 404) or listed.json()["data"] == []


async def test_viewer_key_reads_nothing_in_another_organisation(client, container):
    olive = await signed_in(client, container, name="Olive Owner")
    acme = await make_org(client, olive, "Acme Rockets")
    initech = await make_org(client, olive, "Initech")
    key = await _key_for(client, container, acme, olive, role="viewer")

    members = await client.get(f"/v1/orgs/{initech['id']}/members", headers=key)
    projects = await client.get(f"/v1/orgs/{initech['id']}/projects", headers=key)

    assert members.status_code in (403, 404)
    assert projects.status_code in (403, 404) or projects.json()["data"] == []
    initech_after = await client.get(f"/v1/orgs/{initech['id']}/projects", headers=olive.headers)
    assert initech_after.json()["data"] == []
