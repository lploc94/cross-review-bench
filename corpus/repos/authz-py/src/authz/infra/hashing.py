"""argon2id password hashing."""

from __future__ import annotations

import asyncio
from dataclasses import dataclass

from argon2 import PasswordHasher as Argon2Hasher
from argon2 import Type
from argon2.exceptions import InvalidHashError, VerificationError, VerifyMismatchError

MIN_PASSWORD_LENGTH = 10
MAX_PASSWORD_LENGTH = 256


@dataclass(frozen=True, slots=True)
class HashParameters:
    time_cost: int
    memory_cost_kib: int
    parallelism: int


class PasswordHasher:
    """Hashes and verifies passwords off the event loop; argon2 is deliberately slow."""

    def __init__(self, params: HashParameters) -> None:
        self._params = params
        self._hasher = Argon2Hasher(
            time_cost=params.time_cost,
            memory_cost=params.memory_cost_kib,
            parallelism=params.parallelism,
            type=Type.ID,
        )
        self._dummy_hash: str | None = None

    @property
    def parameters(self) -> HashParameters:
        return self._params

    async def hash(self, password: str) -> str:
        return await asyncio.to_thread(self._hasher.hash, password)

    async def verify(self, password_hash: str, password: str) -> bool:
        return await asyncio.to_thread(self._verify_sync, password_hash, password)

    def _verify_sync(self, password_hash: str, password: str) -> bool:
        try:
            return self._hasher.verify(password_hash, password)
        except (VerifyMismatchError, VerificationError, InvalidHashError):
            return False

    def needs_rehash(self, password_hash: str) -> bool:
        """True when the hash was made with other parameters than the configured ones."""
        try:
            return self._hasher.check_needs_rehash(password_hash)
        except InvalidHashError:
            return True

    async def verify_dummy(self, password: str) -> None:
        """Spend the time of a real verification, for callers that have no hash to check."""
        if self._dummy_hash is None:
            self._dummy_hash = await self.hash("not-a-real-password-for-timing")
        await self.verify(self._dummy_hash, password)
