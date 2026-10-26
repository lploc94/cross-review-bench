"""Inviting people into an organisation."""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import timedelta

from authz.domain.emails import normalize_email
from authz.domain.principal import Actor, Principal
from authz.errors import ConflictError, GoneError, NotFoundError, PermissionDenied
from authz.infra.clock import Clock
from authz.infra.db import Database
from authz.infra.mailer import EmailMessage, Mailer
from authz.infra.randomness import RandomSource, hash_token
from authz.logging import get_logger
from authz.models import Invitation, Membership, Organization, Role
from authz.repositories.invitations import InvitationRepository
from authz.repositories.organizations import MembershipRepository, OrganizationRepository
from authz.repositories.roles import RoleRepository
from authz.repositories.users import UserRepository
from authz.services.audit import AuditAction, AuditLog
from authz.services.authorization import AuthorizationService, ensure_can_grant

log = get_logger(__name__)


@dataclass(frozen=True, slots=True)
class InvitationPolicy:
    ttl: timedelta
    accept_url_base: str


@dataclass(frozen=True, slots=True)
class AcceptedInvitation:
    invitation: Invitation
    membership: Membership


def invitation_email(org: Organization, role: Role, link: str, to: str) -> EmailMessage:
    body = (
        f"You have been invited to join {org.name} as {role.name}.\n\n"
        f"Sign in with this address and open the link below to accept:\n{link}\n\n"
        "If you did not expect this invitation, you can ignore this message."
    )
    return EmailMessage(
        to=to, subject=f"Invitation to join {org.name}", body=body, kind="invitation"
    )


class InvitationService:
    def __init__(
        self,
        *,
        db: Database,
        clock: Clock,
        random: RandomSource,
        authz: AuthorizationService,
        audit: AuditLog,
        mailer: Mailer,
        policy: InvitationPolicy,
    ) -> None:
        self._db = db
        self._clock = clock
        self._random = random
        self._authz = authz
        self._audit = audit
        self._mailer = mailer
        self._policy = policy

    async def create(
        self, principal: Principal, org_id: uuid.UUID, *, email: str, role_id: uuid.UUID
    ) -> Invitation:
        """Invite an address with a role; the token only ever leaves in the email."""
        address = normalize_email(email)
        token = self._random.token()
        async with self._db.transaction() as session:
            org = await OrganizationRepository(session).lock(org_id)
            if org is None:
                raise NotFoundError("organization")
            role = await RoleRepository(session).get(org_id, role_id)
            if role is None:
                raise NotFoundError("role")
            snapshot = await self._authz.snapshot(session, org_id, principal.user_id)
            ensure_can_grant(snapshot, org_id, role.id, action="invite with")

            existing_user = await UserRepository(session).get_by_email(address)
            if existing_user is not None and await MembershipRepository(session).get(
                org_id, existing_user.id
            ):
                raise ConflictError("this person is already a member", details={"field": "email"})
            invitations = InvitationRepository(session)
            now = self._clock.now()
            if await invitations.find_pending(org_id, address, now) is not None:
                raise ConflictError(
                    "a pending invitation for this address already exists",
                    details={"field": "email"},
                )
            invitation = await invitations.add(
                org_id=org_id,
                email=address,
                role_id=role.id,
                token_hash=hash_token(token),
                invited_by=principal.user_id,
                now=now,
                expires_at=now + self._policy.ttl,
            )
            await self._audit.record(
                session,
                Actor.of(principal),
                org_id=org_id,
                action=AuditAction.INVITATION_CREATED,
                target_type="invitation",
                target_id=invitation.id,
                data={"email": address, "role_id": role.id},
            )
        link = f"{self._policy.accept_url_base}/invitations/{token}"
        await self._mailer.send(invitation_email(org, role, link, address))
        log.info("invitation.created", org_id=str(org_id), invitation_id=str(invitation.id))
        return invitation

    async def list_pending(self, org_id: uuid.UUID) -> list[Invitation]:
        async with self._db.read() as session:
            return await InvitationRepository(session).list_pending(org_id, self._clock.now())

    async def accept(self, principal: Principal, token: str) -> AcceptedInvitation:
        """Join the organisation. The signed-in user's address must be the invited one."""
        async with self._db.transaction() as session:
            invitations = InvitationRepository(session)
            invitation = await invitations.get_by_hash_for_update(hash_token(token))
            if invitation is None:
                raise NotFoundError("invitation")
            if invitation.accepted_at is not None:
                raise ConflictError("the invitation has already been used")
            now = self._clock.now()
            if now >= invitation.expires_at:
                raise GoneError("the invitation has expired")
            user = await UserRepository(session).get(principal.user_id)
            if user is None or user.email != invitation.email:
                raise PermissionDenied("the invitation was sent to another address")
            if await OrganizationRepository(session).lock(invitation.org_id) is None:
                raise NotFoundError("invitation")
            membership = await MembershipRepository(session).add(
                org_id=invitation.org_id, user_id=user.id, role_id=invitation.role_id, now=now
            )
            await invitations.mark_accepted(invitation, user.id, now)
            actor = Actor.of(principal)
            await self._audit.record(
                session,
                actor,
                org_id=invitation.org_id,
                action=AuditAction.INVITATION_ACCEPTED,
                target_type="invitation",
                target_id=invitation.id,
                data={"email": invitation.email},
            )
            await self._audit.record(
                session,
                actor,
                org_id=invitation.org_id,
                action=AuditAction.MEMBER_ADDED,
                target_type="user",
                target_id=user.id,
                data={"role_id": invitation.role_id, "invitation_id": invitation.id},
            )
        log.info("invitation.accepted", org_id=str(invitation.org_id), user_id=str(user.id))
        return AcceptedInvitation(invitation, membership)
