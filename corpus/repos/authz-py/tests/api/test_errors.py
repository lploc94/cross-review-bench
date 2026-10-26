from __future__ import annotations

from tests.helpers.factories import signed_in


async def test_unknown_routes_use_the_error_shape(client):
    response = await client.get("/v1/does-not-exist")

    assert response.status_code == 404
    assert response.json()["error"]["code"] == "not_found"


async def test_validation_errors_list_the_fields(client):
    response = await client.post("/v1/auth/login", json={"email": "a@example.com"})

    assert response.status_code == 422
    problems = response.json()["error"]["details"]["problems"]
    assert [p["field"] for p in problems] == ["password"]


async def test_request_id_is_echoed_or_generated(client):
    echoed = await client.get("/health", headers={"X-Request-ID": "req-42"})
    generated = await client.get("/health")

    assert echoed.headers["x-request-id"] == "req-42"
    assert len(generated.headers["x-request-id"]) == 32


async def test_malformed_ids_in_paths_are_validation_errors(client, container):
    me = await signed_in(client, container)

    response = await client.get("/v1/orgs/not-a-uuid", headers=me.headers)

    assert response.status_code == 422
