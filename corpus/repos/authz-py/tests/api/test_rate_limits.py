from __future__ import annotations

from tests.helpers.clock import FrozenClock
from tests.helpers.factories import login, make_user


async def test_login_is_limited_per_email_and_ip(client, container, clock: FrozenClock):
    await make_user(container, "zoe@example.com")
    limit = container.settings.login_rate_limit
    for _ in range(limit):
        response = await login(client, "zoe@example.com", "a wrong password", ip="192.0.2.1")
        assert response.status_code == 401

    blocked = await login(client, "zoe@example.com", ip="192.0.2.1")

    assert blocked.status_code == 429
    assert blocked.json()["error"]["code"] == "rate_limited"
    retry_after = int(blocked.headers["retry-after"])
    assert 0 < retry_after <= container.settings.login_rate_window_seconds
    other_ip = await login(client, "zoe@example.com", ip="192.0.2.2")
    assert other_ip.status_code == 200


async def test_login_limit_resets_in_the_next_window(client, container, clock: FrozenClock):
    await make_user(container, "yuki@example.com")
    for _ in range(container.settings.login_rate_limit):
        await login(client, "yuki@example.com", "a wrong password", ip="192.0.2.9")
    assert (await login(client, "yuki@example.com", ip="192.0.2.9")).status_code == 429

    clock.advance(seconds=container.settings.login_rate_window_seconds)

    assert (await login(client, "yuki@example.com", ip="192.0.2.9")).status_code == 200


async def test_refresh_is_limited_per_ip(client, container):
    limit = container.settings.refresh_rate_limit
    headers = {"X-Forwarded-For": "192.0.2.50"}
    for _ in range(limit):
        response = await client.post(
            "/v1/auth/refresh", json={"refresh_token": "unknown"}, headers=headers
        )
        assert response.status_code == 401

    blocked = await client.post(
        "/v1/auth/refresh", json={"refresh_token": "unknown"}, headers=headers
    )

    assert blocked.status_code == 429
    assert "retry-after" in blocked.headers
