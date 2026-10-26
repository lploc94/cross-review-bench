from __future__ import annotations

from tests.helpers.clock import FrozenClock
from tests.helpers.doubles import RecordingMailer
from tests.helpers.factories import make_user, org_with_member, role_id, signed_in


async def _invite(client, container, org, inviter, email, role="member"):
    rid = await role_id(container, org["id"], role)
    return await client.post(
        f"/v1/orgs/{org['id']}/invitations",
        json={"email": email, "role_id": str(rid)},
        headers=inviter.headers,
    )


async def test_invitation_is_emailed_and_never_returned(client, container, mailer: RecordingMailer):
    org, owner, _ = await org_with_member(client, container, "viewer")

    response = await _invite(client, container, org, owner, "New.Hire@Example.com")

    assert response.status_code == 201
    body = response.json()
    assert body["email"] == "new.hire@example.com"
    assert "token" not in body
    assert "token_hash" not in body
    token = mailer.last_invitation_token("new.hire@example.com")
    assert token not in response.text
    assert mailer.sent[-1].body.count("https://authz.example.com/invitations/") == 1
    pending = await client.get(f"/v1/orgs/{org['id']}/invitations", headers=owner.headers)
    assert [i["id"] for i in pending.json()["data"]] == [body["id"]]


async def test_invited_user_accepts_and_joins(client, container, mailer: RecordingMailer):
    org, owner, _ = await org_with_member(client, container, "viewer")
    await _invite(client, container, org, owner, "lena@example.com", role="member")
    lena = await signed_in(client, container, "lena@example.com")

    response = await client.post(
        f"/v1/invitations/{mailer.last_invitation_token(lena.email)}/accept", headers=lena.headers
    )

    assert response.status_code == 200
    assert response.json()["org_id"] == org["id"]
    member = await client.get(f"/v1/orgs/{org['id']}/members/{lena.id}", headers=lena.headers)
    assert member.json()["role"] == "member"
    pending = await client.get(f"/v1/orgs/{org['id']}/invitations", headers=owner.headers)
    assert pending.json()["data"] == []


async def test_only_the_invited_address_can_accept(client, container, mailer):
    org, owner, _ = await org_with_member(client, container, "viewer")
    await _invite(client, container, org, owner, "omar@example.com")
    intruder = await signed_in(client, container, "intruder@example.com")

    response = await client.post(
        f"/v1/invitations/{mailer.last_invitation_token('omar@example.com')}/accept",
        headers=intruder.headers,
    )

    assert response.status_code == 403


async def test_invitations_are_single_use(client, container, mailer):
    org, owner, _ = await org_with_member(client, container, "viewer")
    await _invite(client, container, org, owner, "pia@example.com")
    pia = await signed_in(client, container, "pia@example.com")
    path = f"/v1/invitations/{mailer.last_invitation_token(pia.email)}/accept"

    assert (await client.post(path, headers=pia.headers)).status_code == 200
    again = await client.post(path, headers=pia.headers)

    assert again.status_code == 409


async def test_expiry_is_reported_as_gone(client, container, mailer, clock: FrozenClock):
    org, owner, _ = await org_with_member(client, container, "viewer")
    await make_user(container, "rosa@example.com")
    await _invite(client, container, org, owner, "rosa@example.com")
    token = mailer.last_invitation_token("rosa@example.com")
    clock.advance(seconds=container.settings.invitation_ttl_seconds + 1)
    login = await client.post(
        "/v1/auth/login",
        json={"email": "rosa@example.com", "password": "correct horse battery staple"},
    )
    headers = {"Authorization": f"Bearer {login.json()['access_token']}"}

    response = await client.post(f"/v1/invitations/{token}/accept", headers=headers)

    assert response.status_code == 410
    assert response.json()["error"]["code"] == "gone"


async def test_unknown_tokens_are_not_found(client, container):
    me = await signed_in(client, container)

    response = await client.post(f"/v1/invitations/{'0' * 64}/accept", headers=me.headers)

    assert response.status_code == 404


async def test_members_and_pending_addresses_cannot_be_invited_twice(client, container):
    org, owner, viewer = await org_with_member(client, container, "viewer")

    member = await _invite(client, container, org, owner, viewer.email)
    first = await _invite(client, container, org, owner, "sam@example.com")
    duplicate = await _invite(client, container, org, owner, "SAM@example.com")

    assert member.status_code == 409
    assert first.status_code == 201
    assert duplicate.status_code == 409


async def test_inviting_requires_invitations_manage(client, container):
    org, _, member = await org_with_member(client, container, "member")

    response = await _invite(client, container, org, member, "tara@example.com", role="viewer")

    assert response.status_code == 403


async def test_admins_cannot_invite_owners(client, container):
    org, _, admin = await org_with_member(client, container, "admin")

    response = await _invite(client, container, org, admin, "uma@example.com", role="owner")

    assert response.status_code == 403
