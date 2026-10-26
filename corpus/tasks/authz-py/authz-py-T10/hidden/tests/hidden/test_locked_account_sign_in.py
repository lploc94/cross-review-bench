"""A locked account cannot sign in with the correct password until the lock expires."""

from __future__ import annotations

from sqlalchemy import func, select

from authz.models import Session
from tests.helpers.clock import FrozenClock
from tests.helpers.factories import login, make_user

WRONG = "not the password at all"


async def _sessions_of(container, user_id) -> int:
    async with container.db.read() as session:
        count = await session.scalar(
            select(func.count()).select_from(Session).where(Session.user_id == user_id)
        )
    return int(count or 0)


async def test_correct_password_is_refused_while_locked(client, container, clock: FrozenClock):
    user = await make_user(container)
    for _ in range(container.settings.lockout_threshold):
        assert (await login(client, user.email, WRONG, ip="203.0.113.5")).status_code == 401

    response = await login(client, user.email, ip="203.0.113.6")

    assert response.status_code == 401
    assert response.json()["error"]["code"] == "invalid_credentials"
    assert await _sessions_of(container, user.id) == 0


async def test_lock_holds_while_guessing_continues(client, container, clock: FrozenClock):
    user = await make_user(container)
    for _ in range(container.settings.lockout_threshold + 2):
        assert (await login(client, user.email, WRONG, ip="203.0.113.7")).status_code == 401

    clock.advance(seconds=container.settings.lockout_seconds - 1)
    refused = await login(client, user.email, ip="203.0.113.8")
    clock.advance(seconds=1)
    accepted = await login(client, user.email, ip="203.0.113.8")

    assert refused.status_code == 401
    assert accepted.status_code == 200
    assert await _sessions_of(container, user.id) == 1
