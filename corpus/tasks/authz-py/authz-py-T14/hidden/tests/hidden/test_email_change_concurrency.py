"""Email changes that overlap: one link confirmed twice, two accounts claiming one address, a
confirmation racing an account creation, and invitations around a change."""

from __future__ import annotations

import asyncio
import uuid

import pytest
from sqlalchemy import func, select, text

from authz.container import Container
from authz.domain.principal import Principal
from authz.errors import ConflictError
from authz.models import User
from authz.repositories.users import UserRepository
from tests.helpers.factories import DEFAULT_PASSWORD, LoggedIn, org_with_member, role_id, signed_in

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
    pytest.fail(f"expected {expected} confirmations waiting for a lock")


def _principal(me: LoggedIn) -> Principal:
    return Principal.user(me.id, uuid.UUID(me.session_id))


async def _link(client, mailer, me: LoggedIn, new_email: str) -> str:
    response = await client.post(
        "/v1/me/email",
        json={"new_email": new_email, "password": DEFAULT_PASSWORD},
        headers=me.headers,
    )
    assert response.status_code == 202, response.text
    return mailer.last_email_change_token(new_email.lower())


async def _users_with(container: Container, address: str) -> list[uuid.UUID]:
    async with container.db.read() as session:
        result = await session.execute(select(User.id).where(func.lower(User.email) == address))
        return list(result.scalars())


async def test_one_link_confirmed_twice_at_once_changes_once(client, container, mailer):
    me = await signed_in(client, container)
    token = await _link(client, mailer, me, "twice@example.com")

    async with container.db.transaction() as holder:
        await holder.execute(select(User).where(User.id == me.id).with_for_update())
        first = asyncio.create_task(container.email_changes.confirm(_principal(me), token))
        second = asyncio.create_task(container.email_changes.confirm(_principal(me), token))
        await _wait_for_lock_waiters(container, 2)

    results = await asyncio.wait_for(
        asyncio.gather(first, second, return_exceptions=True), timeout=30
    )

    assert len([r for r in results if isinstance(r, User)]) == 1, results
    assert len([r for r in results if isinstance(r, ConflictError)]) == 1, results
    assert await _users_with(container, "twice@example.com") == [me.id]


async def test_two_accounts_confirming_one_address_at_once(client, container, mailer):
    ada = await signed_in(client, container)
    bob = await signed_in(client, container)
    ada_token = await _link(client, mailer, ada, "shared@example.com")
    bob_token = await _link(client, mailer, bob, "SHARED@example.com")

    async with container.db.transaction() as holder:
        await holder.execute(select(User).where(User.id.in_([ada.id, bob.id])).with_for_update())
        first = asyncio.create_task(container.email_changes.confirm(_principal(ada), ada_token))
        second = asyncio.create_task(container.email_changes.confirm(_principal(bob), bob_token))
        await _wait_for_lock_waiters(container, 2)

    results = await asyncio.wait_for(
        asyncio.gather(first, second, return_exceptions=True), timeout=30
    )

    winners = [r for r in results if isinstance(r, User)]
    assert len(winners) == 1, results
    assert len([r for r in results if isinstance(r, ConflictError)]) == 1, results
    assert await _users_with(container, "shared@example.com") == [winners[0].id]


async def test_confirmation_racing_an_account_creation_is_refused(client, container, mailer):
    me = await signed_in(client, container)
    token = await _link(client, mailer, me, "claimed@example.com")
    password_hash = await container.hasher.hash(DEFAULT_PASSWORD)

    async with container.db.transaction() as holder:
        created = await UserRepository(holder).add(
            email="claimed@example.com",
            password_hash=password_hash,
            display_name="Cleo Claimed",
            now=container.clock.now(),
        )
        confirming = asyncio.create_task(container.email_changes.confirm(_principal(me), token))
        await _wait_for_lock_waiters(container, 1)

    with pytest.raises(ConflictError):
        await asyncio.wait_for(confirming, timeout=30)
    assert await _users_with(container, "claimed@example.com") == [created.id]
    profile = await client.get("/v1/me", headers=me.headers)
    assert profile.json()["email"] == me.email
    retry = await client.post("/v1/me/email/confirm", json={"token": token}, headers=me.headers)
    assert retry.status_code == 409


async def test_invitations_follow_the_address_not_the_account(client, container, mailer):
    org, owner, _ = await org_with_member(client, container, "viewer")
    rid = str(await role_id(container, org["id"], "member"))
    me = await signed_in(client, container, "vera@example.com")
    for address in ("vera@example.com", "vera.new@example.com"):
        invited = await client.post(
            f"/v1/orgs/{org['id']}/invitations",
            json={"email": address, "role_id": rid},
            headers=owner.headers,
        )
        assert invited.status_code == 201, invited.text
    old_invitation = mailer.last_invitation_token("vera@example.com")
    new_invitation = mailer.last_invitation_token("vera.new@example.com")
    token = await _link(client, mailer, me, "vera.new@example.com")
    confirmed = await client.post("/v1/me/email/confirm", json={"token": token}, headers=me.headers)
    assert confirmed.status_code == 200

    old = await client.post(f"/v1/invitations/{old_invitation}/accept", headers=me.headers)
    new = await client.post(f"/v1/invitations/{new_invitation}/accept", headers=me.headers)

    assert old.status_code == 403
    assert new.status_code == 200
