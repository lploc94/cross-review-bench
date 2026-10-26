"""Invitations: issued inside an organisation, accepted by the invited user."""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, Path, status

from authz.api.deps import Authorized, ContainerDep, PrincipalDep, require
from authz.api.schemas.common import ListResponse
from authz.api.schemas.resources import (
    AcceptedInvitationResponse,
    InvitationCreate,
    InvitationResponse,
)
from authz.domain.permissions import Permission

router = APIRouter(prefix="/v1", tags=["invitations"])

CanManageInvitations = Annotated[Authorized, Depends(require(Permission.INVITATIONS_MANAGE))]


@router.post(
    "/orgs/{org_id}/invitations",
    status_code=status.HTTP_201_CREATED,
    response_model=InvitationResponse,
)
async def create_invitation(
    body: InvitationCreate, auth: CanManageInvitations, container: ContainerDep
) -> InvitationResponse:
    invitation = await container.invitations.create(
        auth.principal, auth.org_id, email=body.email, role_id=body.role_id
    )
    return InvitationResponse.of(invitation)


@router.get("/orgs/{org_id}/invitations", response_model=ListResponse[InvitationResponse])
async def list_invitations(
    auth: CanManageInvitations, container: ContainerDep
) -> ListResponse[InvitationResponse]:
    rows = await container.invitations.list_pending(auth.org_id)
    return ListResponse(data=[InvitationResponse.of(row) for row in rows])


@router.post("/invitations/{token}/accept", response_model=AcceptedInvitationResponse)
async def accept_invitation(
    token: Annotated[str, Path(min_length=16, max_length=256)],
    principal: PrincipalDep,
    container: ContainerDep,
) -> AcceptedInvitationResponse:
    accepted = await container.invitations.accept(principal, token)
    return AcceptedInvitationResponse(
        org_id=accepted.membership.org_id,
        role_id=accepted.membership.role_id,
        user_id=accepted.membership.user_id,
        joined_at=accepted.membership.created_at,
    )
