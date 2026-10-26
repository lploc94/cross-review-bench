from __future__ import annotations

from authz.infra.hashing import HashParameters, PasswordHasher

FAST = HashParameters(time_cost=1, memory_cost_kib=8, parallelism=1)


async def test_verifies_the_right_password_only():
    hasher = PasswordHasher(FAST)
    stored = await hasher.hash("a long passphrase")

    assert await hasher.verify(stored, "a long passphrase")
    assert not await hasher.verify(stored, "another passphrase")
    assert not await hasher.verify("not-a-hash", "a long passphrase")


async def test_needs_rehash_when_parameters_change():
    old = PasswordHasher(FAST)
    new = PasswordHasher(HashParameters(time_cost=2, memory_cost_kib=16, parallelism=1))
    stored = await old.hash("a long passphrase")

    assert not old.needs_rehash(stored)
    assert new.needs_rehash(stored)
    assert new.needs_rehash("garbage")


async def test_dummy_verification_completes():
    hasher = PasswordHasher(FAST)

    await hasher.verify_dummy("anything")
    await hasher.verify_dummy("anything again")
