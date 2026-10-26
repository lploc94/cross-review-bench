"""Signing out the other sessions while one of them is being refreshed, in both orders."""

from __future__ import annotations

import asyncio
import uuid
from collections.abc import Awaitable, Callable
from typing import Any

import pytest
from sqlalchemy import text

from authz.container import Container
from authz.domain.principal import Principal
from authz.errors import InvalidToken
from authz.repositories.sessions import SessionRepository
from authz.services.auth import ClientInfo, TokenPair
from tests.helpers.factories import LoggedIn, bearer, login, signed_in

WAITING_FOR_LOCKS = text(
    "SELECT count(*) FROM pg_stat_activity "
    "WHERE datname = current_database() AND wait_event_type = 'Lock'"
)
INFO = ClientInfo(ip="198.51.100.30", user_agent="pytest")


async def _wait_for_lock_waiters(container: Container, expected: int) -> None:
    for _ in range(1000):
        async with container.db.read() as session:
            waiting = (await session.execute(WAITING_FOR_LOCKS)).scalar_one()
        if waiting >= expected:
            return
        await asyncio.sleep(0.01)
    pytest.fail(f"expected {expected} transaction(s) waiting for a row lock")


def _pause_after(monkeypatch: pytest.MonkeyPatch, name: str) -> tuple[asyncio.Event, asyncio.Event]:
    """Make SessionRepository.<name> wait, after doing its work, until `release` is set."""
    entered, release = asyncio.Event(), asyncio.Event()
    original: Callable[..., Awaitable[Any]] = getattr(SessionRepository, name)

    async def paused(self: SessionRepository, *args: Any, **kwargs: Any) -> Any:
        result = await original(self, *args, **kwargs)
        entered.set()
        await release.wait()
        return result

    monkeypatch.setattr(SessionRepository, name, paused)
    return entered, release


async def _two_sessions(client, container) -> tuple[LoggedIn, dict[str, Any], Principal]:
    me = await signed_in(client, container)
    other = (await login(client, me.email, device_label="Phone")).json()
    principal = Principal.user(me.id, uuid.UUID(me.session_id))
    return me, other, principal


async def _assert_signed_out(client, other: dict[str, Any], pair: TokenPair | None) -> None:
    tokens = [(other["access_token"], other["refresh_token"])]
    if pair is not None:
        tokens.append((pair.access.token, pair.refresh_token))
    for access, refresh in tokens:
        assert (await client.get("/v1/me", headers=bearer(access))).status_code == 401
        refreshed = await client.post("/v1/auth/refresh", json={"refresh_token": refresh})
        assert refreshed.status_code == 401


async def test_refresh_holding_the_session_lock_then_revoke(client, container, monkeypatch):
    me, other, principal = await _two_sessions(client, container)
    entered, release = _pause_after(monkeypatch, "touch")

    refresh = asyncio.create_task(container.auth.refresh(other["refresh_token"], INFO))
    await asyncio.wait_for(entered.wait(), timeout=10)
    revoke = asyncio.create_task(container.sessions.revoke_others(principal))
    await _wait_for_lock_waiters(container, 1)
    release.set()
    pair, revoked = await asyncio.wait_for(asyncio.gather(refresh, revoke), timeout=30)

    assert isinstance(pair, TokenPair)
    assert revoked == [uuid.UUID(other["session_id"])]
    await _assert_signed_out(client, other, pair)
    assert (await client.get("/v1/me", headers=me.headers)).status_code == 200


async def test_revoke_holding_the_session_lock_then_refresh(client, container, monkeypatch):
    me, other, principal = await _two_sessions(client, container)
    entered, release = _pause_after(monkeypatch, "revoke_all_except")

    revoke = asyncio.create_task(container.sessions.revoke_others(principal))
    await asyncio.wait_for(entered.wait(), timeout=10)
    refresh = asyncio.create_task(container.auth.refresh(other["refresh_token"], INFO))
    await _wait_for_lock_waiters(container, 1)
    release.set()
    results = await asyncio.wait_for(
        asyncio.gather(revoke, refresh, return_exceptions=True), timeout=30
    )

    assert results[0] == [uuid.UUID(other["session_id"])]
    assert isinstance(results[1], InvalidToken), results
    await _assert_signed_out(client, other, None)
    assert (await client.get("/v1/me", headers=me.headers)).status_code == 200
