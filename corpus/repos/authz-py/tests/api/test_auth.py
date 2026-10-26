from __future__ import annotations

import jwt
from sqlalchemy import select

from authz.container import Container
from authz.infra.hashing import HashParameters, PasswordHasher
from authz.models import User
from tests.conftest import TEST_SECRET
from tests.helpers.clock import FrozenClock
from tests.helpers.factories import (
    DEFAULT_PASSWORD,
    bearer,
    disable_user,
    login,
    make_user,
    signed_in,
)


async def test_login_returns_access_and_refresh_tokens(client, container: Container):
    user = await make_user(container, "ada@example.com")

    response = await login(client, "ada@example.com", device_label="Laptop")

    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-store"
    body = response.json()
    assert body["token_type"] == "bearer"
    assert body["expires_in"] == container.settings.access_token_ttl_seconds
    assert body["user_id"] == str(user.id)
    claims = jwt.decode(
        body["access_token"],
        TEST_SECRET,
        algorithms=["HS256"],
        options={
            "verify_exp": False,
            "verify_iat": False,
        },
    )
    assert claims["sub"] == str(user.id)
    assert claims["sid"] == body["session_id"]
    assert {"iat", "exp", "jti"} <= claims.keys()
    assert claims["exp"] - claims["iat"] == container.settings.access_token_ttl_seconds


async def test_login_matches_email_case_insensitively(client, container):
    await make_user(container, "grace@example.com")

    response = await login(client, "  Grace@Example.COM ")

    assert response.status_code == 200


async def test_login_failures_are_indistinguishable(client, container):
    await make_user(container, "linus@example.com")

    wrong_password = await login(client, "linus@example.com", "not the password at all")
    unknown_email = await login(client, "nobody@example.com", "not the password at all")

    assert wrong_password.status_code == unknown_email.status_code == 401
    assert wrong_password.json() == unknown_email.json()
    assert wrong_password.json()["error"]["code"] == "invalid_credentials"
    assert wrong_password.headers["www-authenticate"].startswith("Bearer")


async def test_disabled_user_cannot_log_in(client, container):
    user = await make_user(container, "barbara@example.com")
    await disable_user(container, user.id)

    response = await login(client, "barbara@example.com")

    assert response.status_code == 401
    assert response.json()["error"]["code"] == "invalid_credentials"


async def test_login_rehashes_password_when_parameters_change(client, container):
    weaker = PasswordHasher(HashParameters(time_cost=1, memory_cost_kib=16, parallelism=1))
    user = await make_user(container, "edsger@example.com")
    async with container.db.transaction() as session:
        row = await session.get(User, user.id)
        assert row is not None
        row.password_hash = await weaker.hash(DEFAULT_PASSWORD)
    old_hash = row.password_hash

    response = await login(client, "edsger@example.com")

    assert response.status_code == 200
    async with container.db.read() as session:
        stored = (await session.execute(select(User).where(User.id == user.id))).scalar_one()
    assert stored.password_hash != old_hash
    assert not container.hasher.needs_rehash(stored.password_hash)


async def test_refresh_rotates_the_refresh_token(client, container):
    me = await signed_in(client, container)

    response = await client.post("/v1/auth/refresh", json={"refresh_token": me.refresh_token})

    assert response.status_code == 200
    body = response.json()
    assert body["refresh_token"] != me.refresh_token
    assert body["session_id"] == me.session_id
    again = await client.post("/v1/auth/refresh", json={"refresh_token": body["refresh_token"]})
    assert again.status_code == 200


async def test_used_refresh_token_is_rejected(client, container):
    me = await signed_in(client, container)
    first = await client.post("/v1/auth/refresh", json={"refresh_token": me.refresh_token})
    assert first.status_code == 200

    replay = await client.post("/v1/auth/refresh", json={"refresh_token": me.refresh_token})

    assert replay.status_code == 401
    assert replay.json()["error"]["code"] == "invalid_token"


async def test_expired_refresh_token_is_rejected(client, container, clock: FrozenClock):
    me = await signed_in(client, container)
    clock.advance(seconds=container.settings.refresh_token_ttl_seconds)

    response = await client.post("/v1/auth/refresh", json={"refresh_token": me.refresh_token})

    assert response.status_code == 401


async def test_unknown_refresh_token_is_rejected(client):
    response = await client.post("/v1/auth/refresh", json={"refresh_token": "made-up-token"})

    assert response.status_code == 401


async def test_logout_revokes_the_session(client, container):
    me = await signed_in(client, container)

    response = await client.post("/v1/auth/logout", headers=me.headers)

    assert response.status_code == 204
    assert (await client.get("/v1/me", headers=me.headers)).status_code == 401
    refresh = await client.post("/v1/auth/refresh", json={"refresh_token": me.refresh_token})
    assert refresh.status_code == 401


async def test_access_token_expires_by_the_service_clock(client, container, clock: FrozenClock):
    me = await signed_in(client, container)
    assert (await client.get("/v1/me", headers=me.headers)).status_code == 200

    clock.advance(seconds=container.settings.access_token_ttl_seconds + 10)

    response = await client.get("/v1/me", headers=me.headers)
    assert response.status_code == 401


async def test_token_signed_with_another_secret_is_rejected(client, container):
    me = await signed_in(client, container)
    claims = jwt.decode(me.access_token, options={"verify_signature": False})
    forged = jwt.encode(claims, "another-secret-that-is-long-enough-000", algorithm="HS256")

    response = await client.get("/v1/me", headers=bearer(forged))

    assert response.status_code == 401


async def test_requests_without_a_bearer_token_are_rejected(client):
    response = await client.get("/v1/me")

    assert response.status_code == 401
    assert response.headers["www-authenticate"].startswith("Bearer")
    assert response.json()["error"]["code"] == "authentication_failed"


async def test_disabling_a_user_ends_their_access(client, container):
    me = await signed_in(client, container)

    await disable_user(container, me.id)

    assert (await client.get("/v1/me", headers=me.headers)).status_code == 401
    refresh = await client.post("/v1/auth/refresh", json={"refresh_token": me.refresh_token})
    assert refresh.status_code == 401
