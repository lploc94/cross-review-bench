"""Bulk assignment results must line up with the request's items, index by index."""

from __future__ import annotations

import uuid

from tests.helpers.factories import add_member, org_with_member, role_id, signed_in


def _path(org):
    return f"/v1/orgs/{org['id']}/role-assignments:bulk"


async def test_results_follow_request_order(client, container):
    org, owner, _ = await org_with_member(client, container, "viewer")
    users = [await signed_in(client, container) for _ in range(3)]
    for user in users:
        await add_member(container, org["id"], user, "viewer")
    low, mid, high = sorted(users, key=lambda user: user.id)
    member_role = await role_id(container, org["id"], "member")
    missing_project = str(uuid.UUID(int=7))
    # Neither ascending nor descending by user id.
    items = [
        {"user_id": str(mid.id), "role_id": str(member_role)},
        {"user_id": str(high.id), "role_id": str(member_role), "project_id": missing_project},
        {"user_id": str(low.id), "role_id": str(member_role)},
    ]

    response = await client.post(_path(org), json={"items": items}, headers=owner.headers)

    assert response.status_code == 200
    results = response.json()["data"]
    assert [r["user_id"] for r in results] == [item["user_id"] for item in items]
    assert [r["status"] for r in results] == ["created", "failed", "created"]
    assert results[1]["error"]["details"] == {"resource": "project"}
    listed = await client.get(f"/v1/orgs/{org['id']}/role-assignments", headers=owner.headers)
    id_by_user = {a["user_id"]: a["id"] for a in listed.json()["data"]}
    assert results[0]["assignment_id"] == id_by_user[str(mid.id)]
    assert results[2]["assignment_id"] == id_by_user[str(low.id)]


async def test_items_of_one_user_keep_their_positions(client, container):
    org, _, admin = await org_with_member(client, container, "admin")
    target = await signed_in(client, container)
    await add_member(container, org["id"], target, "viewer")
    member_role = await role_id(container, org["id"], "member")
    owner_role = await role_id(container, org["id"], "owner")
    # The admin may hand out `member` but not `owner`; put the larger role id first.
    first, second = sorted([member_role, owner_role], reverse=True)
    items = [
        {"user_id": str(target.id), "role_id": str(first)},
        {"user_id": str(target.id), "role_id": str(second)},
    ]

    response = await client.post(_path(org), json={"items": items}, headers=admin.headers)

    assert response.status_code == 200
    results = response.json()["data"]
    expected = ["created" if role == member_role else "failed" for role in (first, second)]
    assert [r["status"] for r in results] == expected
    refused = results[expected.index("failed")]
    assert refused["error"]["code"] == "permission_denied"
