"""Ownership transfer: who may transfer, what it leaves alone, and two transfers at once."""

from __future__ import annotations

import asyncio
import uuid

import pytest
from sqlalchemy import select, text

from authz.container import Container
from authz.models import Organization
from tests.helpers.factories import add_member, org_with_member, role_id, signed_in

WAITING_FOR_LOCKS = text(
    "SELECT count(*) FROM pg_stat_activity "
    "WHERE datname = current_database() AND wait_event_type = 'Lock'"
)


async def _wait_for_lock_waiters(container: Container, expected: int) -> None:
    for _ in range(1000):
        async with container.db.read() as session:
            waiting = (await session.execute(WAITING_FOR_LOCKS)).scalar_one()
        if waiting >= expected:
            return
        await asyncio.sleep(0.01)
    pytest.fail(f"expected {expected} transfers waiting for the organisation lock")


async def _roles(client, org, member) -> dict[str, str]:
    response = await client.get(f"/v1/orgs/{org['id']}/members", headers=member.headers)
    assert response.status_code == 200
    return {row["user_id"]: row["role"] for row in response.json()["data"]}


async def test_owner_role_through_an_assignment_does_not_allow_a_transfer(client, container):
    org, owner, admin = await org_with_member(client, container, "admin")
    viewer = await signed_in(client, container)
    await add_member(container, org["id"], viewer, "viewer")
    owner_role = await role_id(container, org["id"], "owner")
    assigned = await client.post(
        f"/v1/orgs/{org['id']}/role-assignments",
        json={"user_id": str(admin.id), "role_id": str(owner_role)},
        headers=owner.headers,
    )
    assert assigned.status_code == 201

    response = await client.post(
        f"/v1/orgs/{org['id']}/transfer-ownership",
        json={"user_id": str(viewer.id)},
        headers=admin.headers,
    )

    assert response.status_code == 403
    assert await _roles(client, org, owner) == {
        str(owner.id): "owner",
        str(admin.id): "admin",
        str(viewer.id): "viewer",
    }


async def test_role_assignments_survive_a_transfer(client, container):
    org, owner, member = await org_with_member(client, container, "member")
    viewer_role = await role_id(container, org["id"], "viewer")
    path = f"/v1/orgs/{org['id']}/role-assignments"
    for user in (owner, member):
        created = await client.post(
            path, json={"user_id": str(user.id), "role_id": str(viewer_role)}, headers=owner.headers
        )
        assert created.status_code == 201

    response = await client.post(
        f"/v1/orgs/{org['id']}/transfer-ownership",
        json={"user_id": str(member.id)},
        headers=owner.headers,
    )

    assert response.status_code == 200, response.text
    listed = await client.get(path, headers=member.headers)
    assert sorted(a["user_id"] for a in listed.json()["data"]) == sorted(
        [str(owner.id), str(member.id)]
    )


async def test_the_new_owner_can_hand_it_back(client, container):
    org, owner, admin = await org_with_member(client, container, "admin")
    url = f"/v1/orgs/{org['id']}/transfer-ownership"

    first = await client.post(url, json={"user_id": str(admin.id)}, headers=owner.headers)
    back = await client.post(url, json={"user_id": str(owner.id)}, headers=admin.headers)

    assert first.status_code == 200
    assert back.status_code == 200, back.text
    assert await _roles(client, org, owner) == {str(owner.id): "owner", str(admin.id): "admin"}


async def test_two_transfers_by_one_owner_at_once_hand_over_once(client, container):
    org, owner, first_admin = await org_with_member(client, container, "admin")
    second_admin = await signed_in(client, container)
    await add_member(container, org["id"], second_admin, "admin")
    url = f"/v1/orgs/{org['id']}/transfer-ownership"

    async with container.db.transaction() as holder:
        # Keep the organisation locked until both requests wait for it inside their transaction.
        await holder.execute(
            select(Organization).where(Organization.id == uuid.UUID(org["id"])).with_for_update()
        )
        requests = [
            asyncio.create_task(
                client.post(url, json={"user_id": str(target.id)}, headers=owner.headers)
            )
            for target in (first_admin, second_admin)
        ]
        await _wait_for_lock_waiters(container, 2)

    responses = await asyncio.wait_for(asyncio.gather(*requests), timeout=30)

    assert sorted(r.status_code for r in responses) == [200, 403]
    roles = await _roles(client, org, owner)
    assert roles[str(owner.id)] == "admin"
    assert sorted([roles[str(first_admin.id)], roles[str(second_admin.id)]]) == ["admin", "owner"]
