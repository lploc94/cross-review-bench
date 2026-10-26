from __future__ import annotations

from authz.domain import totp
from tests.helpers.clock import FrozenClock
from tests.helpers.factories import LoggedIn, login, signed_in


async def enrolled(client, container, clock: FrozenClock) -> tuple[LoggedIn, str]:
    me = await signed_in(client, container)
    started = await client.post("/v1/me/totp", json={"password": me.password}, headers=me.headers)
    assert started.status_code == 201, started.text
    secret: str = started.json()["secret"]
    confirmed = await client.post(
        "/v1/me/totp/confirm",
        json={"code": totp.code_at(secret, totp.time_step(clock.now()))},
        headers=me.headers,
    )
    assert confirmed.status_code == 204, confirmed.text
    clock.advance(minutes=10)
    return me, secret


async def complete_login(client, me: LoggedIn, code: str):
    first = await login(client, me.email)
    assert first.status_code == 200, first.text
    assert first.json()["mfa_required"] is True
    return await client.post(
        "/v1/auth/login/totp", json={"mfa_token": first.json()["mfa_token"], "code": code}
    )


async def test_a_code_opens_only_one_session(client, container, clock: FrozenClock):
    me, secret = await enrolled(client, container, clock)
    code = totp.code_at(secret, totp.time_step(clock.now()))

    first = await complete_login(client, me, code)
    replay = await complete_login(client, me, code)

    assert first.status_code == 200, first.text
    assert replay.status_code == 401
    assert replay.json()["error"]["code"] == "invalid_credentials"


async def test_a_used_code_stays_spent_after_the_step_changes(
    client, container, clock: FrozenClock
):
    me, secret = await enrolled(client, container, clock)
    code = totp.code_at(secret, totp.time_step(clock.now()))
    assert (await complete_login(client, me, code)).status_code == 200

    clock.advance(seconds=totp.STEP_SECONDS)
    replay = await complete_login(client, me, code)

    assert replay.status_code == 401
    assert replay.json()["error"]["code"] == "invalid_credentials"


async def test_codes_from_before_the_last_accepted_step_are_refused(
    client, container, clock: FrozenClock
):
    me, secret = await enrolled(client, container, clock)
    step = totp.time_step(clock.now())
    assert (await complete_login(client, me, totp.code_at(secret, step + 1))).status_code == 200

    current = await complete_login(client, me, totp.code_at(secret, step))
    previous = await complete_login(client, me, totp.code_at(secret, step - 1))
    clock.advance(seconds=2 * totp.STEP_SECONDS)
    later = await complete_login(client, me, totp.code_at(secret, step + 2))

    assert current.status_code == 401
    assert previous.status_code == 401
    assert later.status_code == 200, later.text
