from __future__ import annotations

from tests.helpers.clock import FrozenClock
from tests.helpers.factories import login, signed_in


async def test_lists_own_active_sessions_and_marks_the_current_one(client, container):
    me = await signed_in(client, container, "maria@example.com")
    phone = await login(client, me.email, device_label="Phone", ip="203.0.113.7")
    assert phone.status_code == 200

    response = await client.get("/v1/sessions", headers=me.headers)

    assert response.status_code == 200
    sessions = {item["id"]: item for item in response.json()["data"]}
    assert set(sessions) == {me.session_id, phone.json()["session_id"]}
    assert sessions[me.session_id]["current"] is True
    other = sessions[phone.json()["session_id"]]
    assert other["current"] is False
    assert other["device_label"] == "Phone"
    assert other["ip"] == "203.0.113.7"


async def test_revoking_a_session_ends_it(client, container):
    me = await signed_in(client, container, "noor@example.com")
    phone = (await login(client, me.email, device_label="Phone")).json()

    response = await client.delete(f"/v1/sessions/{phone['session_id']}", headers=me.headers)

    assert response.status_code == 204
    listed = await client.get("/v1/sessions", headers=me.headers)
    assert [item["id"] for item in listed.json()["data"]] == [me.session_id]
    probe = await client.get("/v1/me", headers={"Authorization": f"Bearer {phone['access_token']}"})
    assert probe.status_code == 401


async def test_cannot_revoke_someone_elses_session(client, container):
    me = await signed_in(client, container)
    other = await signed_in(client, container)

    response = await client.delete(f"/v1/sessions/{other.session_id}", headers=me.headers)

    assert response.status_code == 404
    assert (await client.get("/v1/me", headers=other.headers)).status_code == 200


async def test_refresh_updates_last_used(client, container, clock: FrozenClock):
    me = await signed_in(client, container)
    clock.advance(minutes=5)

    refreshed = await client.post("/v1/auth/refresh", json={"refresh_token": me.refresh_token})
    headers = {"Authorization": f"Bearer {refreshed.json()['access_token']}"}
    listed = (await client.get("/v1/sessions", headers=headers)).json()["data"]

    assert listed[0]["last_used_at"] > listed[0]["created_at"]
