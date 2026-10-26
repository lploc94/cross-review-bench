from __future__ import annotations

from tests.helpers.factories import bearer, make_org, role_id, signed_in

REQUESTS = 5


async def test_api_key_requests_do_not_use_the_password_hasher(client, container, monkeypatch):
    owner = await signed_in(client, container)
    org = await make_org(client, owner)
    rid = await role_id(container, org["id"], "member")
    created = await client.post(
        f"/v1/orgs/{org['id']}/api-keys",
        json={"name": "Build agent", "role_id": str(rid)},
        headers=owner.headers,
    )
    assert created.status_code == 201, created.text
    key = bearer(created.json()["key"])

    calls: list[str] = []
    hasher = container.hasher
    original_verify, original_hash = hasher.verify, hasher.hash

    async def counting_verify(password_hash: str, password: str) -> bool:
        calls.append("verify")
        return await original_verify(password_hash, password)

    async def counting_hash(password: str) -> str:
        calls.append("hash")
        return await original_hash(password)

    monkeypatch.setattr(hasher, "verify", counting_verify)
    monkeypatch.setattr(hasher, "hash", counting_hash)

    for _ in range(REQUESTS):
        response = await client.get(f"/v1/orgs/{org['id']}/projects", headers=key)
        assert response.status_code == 200, response.text
    forged = bearer(created.json()["key"][:-4] + "abcd")
    assert (await client.get(f"/v1/orgs/{org['id']}", headers=forged)).status_code == 401

    assert calls == []
