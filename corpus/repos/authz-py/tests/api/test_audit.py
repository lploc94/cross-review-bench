from __future__ import annotations

import pytest
from sqlalchemy import select, update
from sqlalchemy.exc import DBAPIError

from authz.models import AuditEvent
from tests.helpers.clock import FrozenClock
from tests.helpers.factories import org_with_member, role_id


async def test_changes_are_audited_with_actor_and_ip(client, container):
    org, owner, _ = await org_with_member(client, container, "viewer")

    await client.post(
        f"/v1/orgs/{org['id']}/projects",
        json={"name": "Apollo"},
        headers={**owner.headers, "X-Forwarded-For": "203.0.113.44"},
    )
    response = await client.get(f"/v1/orgs/{org['id']}/audit", headers=owner.headers)

    assert response.status_code == 200
    newest = response.json()["data"][0]
    assert newest["action"] == "project.created"
    assert newest["actor_id"] == str(owner.id)
    assert newest["ip"] == "203.0.113.44"
    assert newest["data"] == {"name": "Apollo"}
    assert response.json()["data"][-1]["action"] == "org.created"


async def test_audit_log_is_keyset_paginated_newest_first(client, container, clock: FrozenClock):
    org, owner, _ = await org_with_member(client, container, "viewer")
    base = f"/v1/orgs/{org['id']}/projects"
    for name in ("One", "Two", "Three", "Four"):
        clock.advance(seconds=1)
        await client.post(base, json={"name": name}, headers=owner.headers)

    seen: list[str] = []
    cursor = None
    while True:
        params = {"limit": 2, "action": "project.created"}
        if cursor:
            params["cursor"] = cursor
        page = (
            await client.get(f"/v1/orgs/{org['id']}/audit", params=params, headers=owner.headers)
        ).json()
        seen.extend(event["data"]["name"] for event in page["data"])
        cursor = page["next_cursor"]
        if cursor is None:
            break

    assert seen == ["Four", "Three", "Two", "One"]


async def test_events_with_the_same_timestamp_keep_a_stable_order(client, container):
    org, owner, _ = await org_with_member(client, container, "viewer")
    base = f"/v1/orgs/{org['id']}/projects"
    for name in ("A", "B", "C"):
        await client.post(base, json={"name": name}, headers=owner.headers)

    first = (
        await client.get(
            f"/v1/orgs/{org['id']}/audit",
            params={"limit": 1, "action": "project.created"},
            headers=owner.headers,
        )
    ).json()
    rest = (
        await client.get(
            f"/v1/orgs/{org['id']}/audit",
            params={"limit": 5, "action": "project.created", "cursor": first["next_cursor"]},
            headers=owner.headers,
        )
    ).json()

    names = [e["data"]["name"] for e in first["data"] + rest["data"]]
    assert names == ["C", "B", "A"]


async def test_malformed_cursor_is_rejected(client, container):
    org, owner, _ = await org_with_member(client, container, "viewer")

    response = await client.get(
        f"/v1/orgs/{org['id']}/audit", params={"cursor": "not-a-cursor"}, headers=owner.headers
    )

    assert response.status_code == 422
    assert response.json()["error"]["details"]["field"] == "cursor"


async def test_reading_the_audit_log_requires_audit_read(client, container):
    org, _, member = await org_with_member(client, container, "member")

    response = await client.get(f"/v1/orgs/{org['id']}/audit", headers=member.headers)

    assert response.status_code == 403


async def test_refused_changes_leave_no_audit_event(client, container):
    org, owner, _ = await org_with_member(client, container, "viewer")
    admin_role = await role_id(container, org["id"], "admin")

    # A refused change records nothing.
    response = await client.patch(
        f"/v1/orgs/{org['id']}/members/{owner.id}",
        json={"role_id": str(admin_role)},
        headers=owner.headers,
    )

    assert response.status_code == 409
    async with container.db.read() as session:
        actions = (await session.execute(select(AuditEvent.action))).scalars().all()
    assert "member.role_changed" not in actions


async def test_audit_events_cannot_be_modified(container, client):
    await org_with_member(client, container, "viewer")

    with pytest.raises(DBAPIError, match="cannot be modified"):
        async with container.db.transaction() as session:
            await session.execute(update(AuditEvent).values(action="tampered"))
