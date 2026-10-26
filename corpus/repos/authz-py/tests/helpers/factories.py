"""Builders for users, logins, organisations and memberships."""

from __future__ import annotations

import itertools
import uuid
from dataclasses import dataclass
from typing import Any

import httpx
from sqlalchemy import update

from authz.container import Container
from authz.domain.principal import Actor
from authz.models import Membership, User
from authz.repositories.organizations import MembershipRepository
from authz.repositories.roles import RoleRepository

DEFAULT_PASSWORD = "correct horse battery staple"

_sequence = itertools.count(1)


def unique_email(prefix: str = "user") -> str:
    return f"{prefix}{next(_sequence)}@example.com"


@dataclass
class LoggedIn:
    """A user with a live session, as the API sees them."""

    user: User
    password: str
    access_token: str
    refresh_token: str
    session_id: str

    @property
    def id(self) -> uuid.UUID:
        return self.user.id

    @property
    def email(self) -> str:
        return self.user.email

    @property
    def headers(self) -> dict[str, str]:
        return bearer(self.access_token)


def bearer(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


async def make_user(
    container: Container,
    email: str | None = None,
    *,
    password: str = DEFAULT_PASSWORD,
    name: str = "Test User",
) -> User:
    return await container.users.create(
        email=email or unique_email(), password=password, display_name=name
    )


async def login(
    client: httpx.AsyncClient,
    email: str,
    password: str = DEFAULT_PASSWORD,
    *,
    ip: str = "198.51.100.10",
    **extra: Any,
) -> httpx.Response:
    return await client.post(
        "/v1/auth/login",
        json={"email": email, "password": password, **extra},
        headers={"X-Forwarded-For": ip},
    )


async def signed_in(
    client: httpx.AsyncClient,
    container: Container,
    email: str | None = None,
    *,
    password: str = DEFAULT_PASSWORD,
    name: str = "Test User",
) -> LoggedIn:
    user = await make_user(container, email, password=password, name=name)
    response = await login(client, user.email, password)
    assert response.status_code == 200, response.text
    body = response.json()
    return LoggedIn(
        user=user,
        password=password,
        access_token=body["access_token"],
        refresh_token=body["refresh_token"],
        session_id=body["session_id"],
    )


async def make_org(
    client: httpx.AsyncClient, owner: LoggedIn, name: str = "Acme Rockets"
) -> dict[str, Any]:
    response = await client.post("/v1/orgs", json={"name": name}, headers=owner.headers)
    assert response.status_code == 201, response.text
    body: dict[str, Any] = response.json()
    return body


async def role_id(container: Container, org_id: str | uuid.UUID, name: str) -> uuid.UUID:
    async with container.db.read() as session:
        role = await RoleRepository(session).get_by_name(uuid.UUID(str(org_id)), name)
    assert role is not None, f"no role {name}"
    return role.id


async def add_member(
    container: Container, org_id: str | uuid.UUID, user: LoggedIn | User, role: str
) -> Membership:
    """Put a user straight into an organisation, bypassing invitations."""
    org = uuid.UUID(str(org_id))
    rid = await role_id(container, org, role)
    user_id = user.id
    async with container.db.transaction() as session:
        return await MembershipRepository(session).add(
            org_id=org, user_id=user_id, role_id=rid, now=container.clock.now()
        )


async def org_with_member(
    client: httpx.AsyncClient, container: Container, role: str
) -> tuple[dict[str, Any], LoggedIn, LoggedIn]:
    """An organisation, its owner and a second user holding `role`."""
    owner = await signed_in(client, container, name="Olive Owner")
    org = await make_org(client, owner)
    other = await signed_in(client, container, name=f"Rory {role.title()}")
    await add_member(container, org["id"], other, role)
    return org, owner, other


async def disable_user(container: Container, user_id: uuid.UUID) -> None:
    async with container.db.transaction() as session:
        await session.execute(
            update(User).where(User.id == user_id).values(disabled_at=container.clock.now())
        )


def system_actor() -> Actor:
    return Actor.system()
