from __future__ import annotations

import pytest

from authz.errors import ConflictError, InvalidInputError


async def test_create_normalises_the_email(container):
    user = await container.users.create(email=" Wen@Example.COM ", password="long enough pw")

    assert user.email == "wen@example.com"
    assert user.password_hash.startswith("$argon2id$")


async def test_emails_are_unique_case_insensitively(container):
    await container.users.create(email="xavier@example.com", password="long enough pw")

    with pytest.raises(ConflictError):
        await container.users.create(email="XAVIER@example.com", password="long enough pw")


@pytest.mark.parametrize("password", ["short", " leading-space-pw", "x" * 300])
async def test_weak_or_odd_passwords_are_refused(container, password):
    with pytest.raises(InvalidInputError):
        await container.users.create(email="yara@example.com", password=password)


async def test_invalid_emails_are_refused(container):
    with pytest.raises(InvalidInputError):
        await container.users.create(email="not-an-email", password="long enough pw")
