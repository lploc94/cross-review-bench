"""Queries on organisations and memberships."""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import datetime

from sqlalchemy import and_, func, or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from authz.domain.pagination import Cursor
from authz.errors import ConflictError
from authz.models import Membership, Organization, Role, User


@dataclass(frozen=True, slots=True)
class OrganizationWithRole:
    organization: Organization
    role_name: str


@dataclass(frozen=True, slots=True)
class MemberRow:
    membership: Membership
    user: User
    role: Role


class OrganizationRepository:
    def __init__(self, session: AsyncSession) -> None:
        self._session = session

    async def add(self, *, name: str, slug: str, now: datetime) -> Organization:
        org = Organization(id=uuid.uuid4(), name=name, slug=slug, created_at=now, updated_at=now)
        self._session.add(org)
        try:
            async with self._session.begin_nested():
                await self._session.flush()
        except IntegrityError:
            raise ConflictError(
                "an organisation with this slug already exists", details={"field": "slug"}
            ) from None
        return org

    async def get(self, org_id: uuid.UUID) -> Organization | None:
        return await self._session.get(Organization, org_id)

    async def lock(self, org_id: uuid.UUID) -> Organization | None:
        """Lock the organisation row; serialises changes that check organisation-wide rules.

        FOR NO KEY UPDATE: lockers still exclude each other, but rows that only reference the
        organisation (audit events, memberships) can be inserted meanwhile, so a change that
        holds this lock and one that writes such a row cannot deadlock.
        """
        result = await self._session.execute(
            select(Organization).where(Organization.id == org_id).with_for_update(key_share=True)
        )
        return result.scalar_one_or_none()

    async def slug_taken(self, slug: str) -> bool:
        result = await self._session.execute(
            select(func.count()).select_from(Organization).where(Organization.slug == slug)
        )
        return result.scalar_one() > 0

    async def list_for_user(self, user_id: uuid.UUID) -> list[OrganizationWithRole]:
        result = await self._session.execute(
            select(Organization, Role.name)
            .join(Membership, Membership.org_id == Organization.id)
            .join(Role, Role.id == Membership.role_id)
            .where(Membership.user_id == user_id)
            .order_by(Organization.name, Organization.id)
        )
        return [OrganizationWithRole(org, role_name) for org, role_name in result]

    async def rename(self, org: Organization, name: str, now: datetime) -> None:
        org.name = name
        org.updated_at = now
        await self._session.flush()


class MembershipRepository:
    def __init__(self, session: AsyncSession) -> None:
        self._session = session

    async def add(
        self, *, org_id: uuid.UUID, user_id: uuid.UUID, role_id: uuid.UUID, now: datetime
    ) -> Membership:
        membership = Membership(
            id=uuid.uuid4(),
            org_id=org_id,
            user_id=user_id,
            role_id=role_id,
            created_at=now,
            updated_at=now,
        )
        self._session.add(membership)
        try:
            async with self._session.begin_nested():
                await self._session.flush()
        except IntegrityError:
            raise ConflictError("the user is already a member of this organisation") from None
        return membership

    async def get(self, org_id: uuid.UUID, user_id: uuid.UUID) -> Membership | None:
        result = await self._session.execute(
            select(Membership).where(Membership.org_id == org_id, Membership.user_id == user_id)
        )
        return result.scalar_one_or_none()

    async def get_member(self, org_id: uuid.UUID, user_id: uuid.UUID) -> MemberRow | None:
        result = await self._session.execute(
            select(Membership, User, Role)
            .join(User, User.id == Membership.user_id)
            .join(Role, Role.id == Membership.role_id)
            .where(Membership.org_id == org_id, Membership.user_id == user_id)
        )
        row = result.one_or_none()
        return MemberRow(*row) if row else None

    async def list_members(
        self, org_id: uuid.UUID, *, limit: int, after: Cursor | None
    ) -> list[MemberRow]:
        """Members in joining order, oldest first; `limit + 1` rows tell whether more remain."""
        query = (
            select(Membership, User, Role)
            .join(User, User.id == Membership.user_id)
            .join(Role, Role.id == Membership.role_id)
            .where(Membership.org_id == org_id)
        )
        if after is not None:
            after_id = after.id_as_uuid()
            query = query.where(
                or_(
                    Membership.created_at > after.created_at,
                    and_(Membership.created_at == after.created_at, Membership.id > after_id),
                )
            )
        result = await self._session.execute(
            query.order_by(Membership.created_at, Membership.id).limit(limit + 1)
        )
        return [MemberRow(*row) for row in result]

    async def count_with_role(self, org_id: uuid.UUID, role_id: uuid.UUID) -> int:
        result = await self._session.execute(
            select(func.count())
            .select_from(Membership)
            .where(Membership.org_id == org_id, Membership.role_id == role_id)
        )
        return result.scalar_one()

    async def set_role(self, membership: Membership, role_id: uuid.UUID, now: datetime) -> None:
        membership.role_id = role_id
        membership.updated_at = now
        await self._session.flush()

    async def remove(self, membership: Membership) -> None:
        await self._session.delete(membership)
        await self._session.flush()
