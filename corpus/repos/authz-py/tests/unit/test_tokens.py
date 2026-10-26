from __future__ import annotations

import uuid

import jwt
import pytest

from authz.errors import InvalidToken
from authz.services.tokens import AccessTokenCodec
from tests.helpers.clock import FrozenClock
from tests.helpers.doubles import SeededRandom

OLD = "old-secret-0123456789abcdef0123456789"
NEW = "new-secret-0123456789abcdef0123456789"


def codec(secrets, clock, ttl=900):
    return AccessTokenCodec(
        secrets,
        issuer="authz",
        ttl_seconds=ttl,
        leeway_seconds=5,
        clock=clock,
        random=SeededRandom(),
    )


def test_round_trip_carries_user_and_session():
    clock = FrozenClock()
    user, session = uuid.uuid4(), uuid.uuid4()

    issued = codec([NEW], clock).issue(user, session)
    claims = codec([NEW], clock).decode(issued.token)

    assert (claims.user_id, claims.session_id) == (user, session)
    assert (
        claims.expires_at - claims.issued_at == issued.claims.expires_at - issued.claims.issued_at
    )
    assert issued.expires_in == 900


def test_rotation_signs_with_the_first_secret_and_accepts_the_others():
    clock = FrozenClock()
    old_token = codec([OLD], clock).issue(uuid.uuid4(), uuid.uuid4()).token
    rotated = codec([NEW, OLD], clock)

    assert rotated.decode(old_token)
    new_token = rotated.issue(uuid.uuid4(), uuid.uuid4()).token
    assert jwt.get_unverified_header(new_token)["alg"] == "HS256"
    with pytest.raises(InvalidToken):
        codec([OLD], clock).decode(new_token)


def test_expiry_uses_the_injected_clock_with_leeway():
    clock = FrozenClock()
    tokens = codec([NEW], clock, ttl=60)
    token = tokens.issue(uuid.uuid4(), uuid.uuid4()).token

    clock.advance(seconds=64)
    assert tokens.decode(token)
    clock.advance(seconds=1)
    with pytest.raises(InvalidToken, match="expired"):
        tokens.decode(token)


def test_tampered_and_foreign_tokens_are_rejected():
    clock = FrozenClock()
    tokens = codec([NEW], clock)
    token = tokens.issue(uuid.uuid4(), uuid.uuid4()).token
    head, payload, signature = token.split(".")
    tampered = f"{head}.{payload}.{signature[::-1]}"
    other_issuer = jwt.encode(
        {**jwt.decode(token, options={"verify_signature": False}), "iss": "elsewhere"},
        NEW,
        algorithm="HS256",
    )
    missing_sid = jwt.encode(
        {
            k: v
            for k, v in jwt.decode(token, options={"verify_signature": False}).items()
            if k != "sid"
        },
        NEW,
        algorithm="HS256",
    )

    for bad in (tampered, other_issuer, missing_sid, "not-a-jwt"):
        with pytest.raises(InvalidToken):
            tokens.decode(bad)


def test_none_algorithm_is_refused():
    clock = FrozenClock()
    tokens = codec([NEW], clock)
    claims = jwt.decode(
        tokens.issue(uuid.uuid4(), uuid.uuid4()).token, options={"verify_signature": False}
    )
    unsigned = jwt.encode(claims, None, algorithm="none")

    with pytest.raises(InvalidToken):
        tokens.decode(unsigned)
