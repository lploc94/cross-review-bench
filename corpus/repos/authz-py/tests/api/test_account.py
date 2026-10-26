from __future__ import annotations

from tests.helpers.factories import signed_in


async def test_me_returns_the_profile(client, container):
    me = await signed_in(client, container, "ines@example.com", name="Ines Example")

    response = await client.get("/v1/me", headers=me.headers)

    assert response.status_code == 200
    body = response.json()
    assert body["email"] == "ines@example.com"
    assert body["display_name"] == "Ines Example"
    assert "password_hash" not in body


async def test_update_display_name(client, container):
    me = await signed_in(client, container)

    response = await client.patch(
        "/v1/me", json={"display_name": "  Kai   Example "}, headers=me.headers
    )

    assert response.status_code == 200
    assert response.json()["display_name"] == "Kai Example"


async def test_unknown_fields_are_rejected(client, container):
    me = await signed_in(client, container)

    response = await client.patch(
        "/v1/me", json={"display_name": "Kai", "email": "x@example.com"}, headers=me.headers
    )

    assert response.status_code == 422
    assert response.json()["error"]["code"] == "validation_error"
