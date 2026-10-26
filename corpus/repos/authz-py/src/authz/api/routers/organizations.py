"""Organisations and their members."""

from __future__ import annotations

import uuid
from typing import Annotated

from fastapi import APIRouter, Depends, Query, Response, status

from authz.api.deps import (
    Authorized,
    ContainerDep,
    OrgContextDep,
    PrincipalDep,
    require,
)
from authz.api.schemas.common import ListResponse, PageResponse
from authz.api.schemas.organizations import (
    MemberResponse,
    MemberUpdate,
    MyOrganizationResponse,
    OrganizationCreate,
    OrganizationDetailResponse,
    OrganizationResponse,
    OrganizationUpdate,
)
from authz.domain.permissions import Permission
from authz.domain.principal import Actor

router = APIRouter(prefix="/v1/orgs", tags=["organizations"])

CanReadOrg = Annotated[Authorized, Depends(require(Permission.ORG_READ))]
CanManageOrg = Annotated[Authorized, Depends(require(Permission.ORG_MANAGE))]
CanReadMembers = Annotated[Authorized, Depends(require(Permission.MEMBERS_READ))]
CanManageMembers = Annotated[Authorized, Depends(require(Permission.MEMBERS_MANAGE))]


@router.post("", status_code=status.HTTP_201_CREATED, response_model=OrganizationResponse)
async def create_organization(
    body: OrganizationCreate, principal: PrincipalDep, container: ContainerDep
) -> OrganizationResponse:
    created = await container.organizations.create(
        principal.user_id, name=body.name, slug=body.slug, actor=Actor.of(principal)
    )
    return OrganizationResponse.of(created.organization)


@router.get("", response_model=ListResponse[MyOrganizationResponse])
async def list_my_organizations(
    principal: PrincipalDep, container: ContainerDep
) -> ListResponse[MyOrganizationResponse]:
    rows = await container.organizations.list_for_user(principal)
    return ListResponse(data=[MyOrganizationResponse.mine(row) for row in rows])


@router.get("/{org_id}", response_model=OrganizationDetailResponse)
async def get_organization(auth: CanReadOrg, container: ContainerDep) -> OrganizationDetailResponse:
    org = await container.organizations.get(auth.org_id)
    permissions = await container.authz.permissions(auth.principal, auth.resource)
    base = OrganizationResponse.of(org)
    return OrganizationDetailResponse(**base.model_dump(), permissions=sorted(permissions))


@router.patch("/{org_id}", response_model=OrganizationResponse)
async def update_organization(
    body: OrganizationUpdate, auth: CanManageOrg, container: ContainerDep
) -> OrganizationResponse:
    org = await container.organizations.rename(auth.principal, auth.org_id, body.name)
    return OrganizationResponse.of(org)


@router.get("/{org_id}/members", response_model=PageResponse[MemberResponse])
async def list_members(
    auth: CanReadMembers,
    container: ContainerDep,
    cursor: Annotated[str | None, Query(max_length=512)] = None,
    limit: Annotated[int | None, Query(ge=1, le=200)] = None,
) -> PageResponse[MemberResponse]:
    page = await container.members.page(auth.org_id, cursor=cursor, limit=limit)
    return PageResponse(
        data=[MemberResponse.of(row) for row in page.items], next_cursor=page.next_cursor
    )


@router.get("/{org_id}/members/{user_id}", response_model=MemberResponse)
async def get_member(
    user_id: uuid.UUID, auth: CanReadMembers, container: ContainerDep
) -> MemberResponse:
    return MemberResponse.of(await container.members.get(auth.org_id, user_id))


@router.patch("/{org_id}/members/{user_id}", response_model=MemberResponse)
async def change_member_role(
    user_id: uuid.UUID, body: MemberUpdate, auth: CanManageMembers, container: ContainerDep
) -> MemberResponse:
    row = await container.members.change_role(auth.principal, auth.org_id, user_id, body.role_id)
    return MemberResponse.of(row)


@router.delete("/{org_id}/members/{user_id}", status_code=status.HTTP_204_NO_CONTENT)
async def remove_member(
    user_id: uuid.UUID, ctx: OrgContextDep, container: ContainerDep
) -> Response:
    """Members may leave on their own; removing someone else needs members:manage."""
    await container.members.remove(ctx.principal, ctx.org_id, user_id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)
