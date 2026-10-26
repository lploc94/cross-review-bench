"""Organisations (tenants)."""

from __future__ import annotations

import re
import unicodedata
import uuid
from dataclasses import dataclass

from authz.domain.permissions import BuiltinRole
from authz.domain.principal import Actor, Principal
from authz.errors import InvalidInputError, NotFoundError
from authz.infra.clock import Clock
from authz.infra.db import Database
from authz.infra.randomness import RandomSource
from authz.logging import get_logger
from authz.models import Membership, Organization
from authz.repositories.organizations import (
    MembershipRepository,
    OrganizationRepository,
    OrganizationWithRole,
)
from authz.services.audit import AuditAction, AuditLog
from authz.services.roles import seed_builtin_roles

log = get_logger(__name__)

MAX_NAME_LENGTH = 100
MAX_SLUG_LENGTH = 48
SLUG = re.compile(r"^[a-z0-9]+(-[a-z0-9]+)*$")


def clean_org_name(name: str) -> str:
    cleaned = " ".join(name.split())
    if not cleaned or len(cleaned) > MAX_NAME_LENGTH:
        raise InvalidInputError(
            f"the name must have 1 to {MAX_NAME_LENGTH} characters", details={"field": "name"}
        )
    return cleaned


def slugify(name: str) -> str:
    ascii_name = unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode()
    slug = re.sub(r"[^a-z0-9]+", "-", ascii_name.lower()).strip("-")
    return slug[:MAX_SLUG_LENGTH].strip("-") or "org"


def validate_slug(slug: str) -> str:
    if not SLUG.match(slug) or len(slug) > MAX_SLUG_LENGTH:
        raise InvalidInputError(
            "slugs are lower-case letters and digits separated by single dashes",
            details={"field": "slug"},
        )
    return slug


@dataclass(frozen=True, slots=True)
class CreatedOrganization:
    organization: Organization
    owner_membership: Membership


class OrganizationService:
    def __init__(
        self, *, db: Database, clock: Clock, random: RandomSource, audit: AuditLog
    ) -> None:
        self._db = db
        self._clock = clock
        self._random = random
        self._audit = audit

    async def create(
        self, owner_id: uuid.UUID, *, name: str, slug: str | None = None, actor: Actor
    ) -> CreatedOrganization:
        """Create an organisation with its built-in roles; owner_id becomes its first owner."""
        org_name = clean_org_name(name)
        async with self._db.transaction() as session:
            orgs = OrganizationRepository(session)
            if slug is not None:
                org_slug = validate_slug(slug)
            else:
                org_slug = slugify(org_name)
                if await orgs.slug_taken(org_slug):
                    suffix = self._random.uuid().hex[:6]
                    org_slug = f"{org_slug[: MAX_SLUG_LENGTH - 7].strip('-')}-{suffix}"
            now = self._clock.now()
            org = await orgs.add(name=org_name, slug=org_slug, now=now)
            roles = await seed_builtin_roles(session, org.id, now)
            membership = await MembershipRepository(session).add(
                org_id=org.id, user_id=owner_id, role_id=roles[BuiltinRole.OWNER].id, now=now
            )
            await self._audit.record(
                session,
                actor,
                org_id=org.id,
                action=AuditAction.ORG_CREATED,
                target_type="organization",
                target_id=org.id,
                data={"name": org.name, "slug": org.slug, "owner_id": owner_id},
            )
        log.info("org.created", org_id=str(org.id))
        return CreatedOrganization(org, membership)

    async def list_for_user(self, principal: Principal) -> list[OrganizationWithRole]:
        async with self._db.read() as session:
            return await OrganizationRepository(session).list_for_user(principal.user_id)

    async def get(self, org_id: uuid.UUID) -> Organization:
        async with self._db.read() as session:
            org = await OrganizationRepository(session).get(org_id)
        if org is None:
            raise NotFoundError("organization")
        return org

    async def rename(self, principal: Principal, org_id: uuid.UUID, name: str) -> Organization:
        org_name = clean_org_name(name)
        async with self._db.transaction() as session:
            orgs = OrganizationRepository(session)
            org = await orgs.lock(org_id)
            if org is None:
                raise NotFoundError("organization")
            previous = org.name
            if previous != org_name:
                await orgs.rename(org, org_name, self._clock.now())
                await self._audit.record(
                    session,
                    Actor.of(principal),
                    org_id=org.id,
                    action=AuditAction.ORG_UPDATED,
                    target_type="organization",
                    target_id=org.id,
                    data={"name": {"from": previous, "to": org_name}},
                )
        return org
