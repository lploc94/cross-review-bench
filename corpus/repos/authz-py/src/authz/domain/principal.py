"""Who is calling and what they are acting on."""

from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum
from uuid import UUID


class PrincipalKind(StrEnum):
    USER = "user"


@dataclass(frozen=True, slots=True)
class Principal:
    """An authenticated caller. Users authenticate with an access token bound to a session."""

    kind: PrincipalKind
    user_id: UUID
    session_id: UUID | None
    ip: str | None = None
    user_agent: str | None = None

    @classmethod
    def user(
        cls,
        user_id: UUID,
        session_id: UUID | None,
        *,
        ip: str | None = None,
        user_agent: str | None = None,
    ) -> Principal:
        return cls(
            kind=PrincipalKind.USER,
            user_id=user_id,
            session_id=session_id,
            ip=ip,
            user_agent=user_agent,
        )


@dataclass(frozen=True, slots=True)
class Resource:
    """What a permission is checked against: an organisation, or one project inside it."""

    org_id: UUID
    project_id: UUID | None = None

    @property
    def is_project(self) -> bool:
        return self.project_id is not None

    def describe(self) -> str:
        if self.project_id is None:
            return f"org:{self.org_id}"
        return f"org:{self.org_id}/project:{self.project_id}"


@dataclass(frozen=True, slots=True)
class Actor:
    """The author of a change, as recorded in the audit log."""

    user_id: UUID | None
    ip: str | None = None

    @classmethod
    def of(cls, principal: Principal) -> Actor:
        return cls(user_id=principal.user_id, ip=principal.ip)

    @classmethod
    def system(cls) -> Actor:
        return cls(user_id=None, ip=None)
