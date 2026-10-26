"""Roles, role assignments and the permission catalogue."""

from __future__ import annotations

import uuid
from typing import Annotated

from fastapi import APIRouter, Depends, Query, Response, status

from authz.api.deps import Authorized, ContainerDep, PrincipalDep, require
from authz.api.schemas.common import ListResponse
from authz.api.schemas.organizations import (
    PermissionResponse,
    RoleAssignmentCreate,
    RoleAssignmentResponse,
    RoleCreate,
    RoleResponse,
    RoleUpdate,
)
from authz.domain.permissions import PERMISSION_DESCRIPTIONS, PROJECT_SCOPED, Permission
from authz.services.members import AssignmentRequest
from authz.services.roles import RoleChanges

router = APIRouter(prefix="/v1", tags=["roles"])

CanReadRoles = Annotated[Authorized, Depends(require(Permission.ROLES_READ))]
CanManageRoles = Annotated[Authorized, Depends(require(Permission.ROLES_MANAGE))]
CanReadMembers = Annotated[Authorized, Depends(require(Permission.MEMBERS_READ))]
CanManageMembers = Annotated[Authorized, Depends(require(Permission.MEMBERS_MANAGE))]


@router.get("/permissions", response_model=ListResponse[PermissionResponse])
async def list_permissions(_: PrincipalDep) -> ListResponse[PermissionResponse]:
    return ListResponse(
        data=[
            PermissionResponse(
                name=permission.value,
                description=PERMISSION_DESCRIPTIONS[permission],
                project_scoped=permission in PROJECT_SCOPED,
            )
            for permission in Permission
        ]
    )


@router.get("/orgs/{org_id}/roles", response_model=ListResponse[RoleResponse])
async def list_roles(auth: CanReadRoles, container: ContainerDep) -> ListResponse[RoleResponse]:
    views = await container.roles.list_roles(auth.org_id)
    return ListResponse(data=[RoleResponse.of(view) for view in views])


@router.post(
    "/orgs/{org_id}/roles", status_code=status.HTTP_201_CREATED, response_model=RoleResponse
)
async def create_role(
    body: RoleCreate, auth: CanManageRoles, container: ContainerDep
) -> RoleResponse:
    view = await container.roles.create(
        auth.principal,
        auth.org_id,
        name=body.name,
        description=body.description,
        permissions=body.permissions,
        parent_role_id=body.parent_role_id,
    )
    return RoleResponse.of(view)


@router.get("/orgs/{org_id}/roles/{role_id}", response_model=RoleResponse)
async def get_role(role_id: uuid.UUID, auth: CanReadRoles, container: ContainerDep) -> RoleResponse:
    return RoleResponse.of(await container.roles.get(auth.org_id, role_id))


@router.patch("/orgs/{org_id}/roles/{role_id}", response_model=RoleResponse)
async def update_role(
    role_id: uuid.UUID, body: RoleUpdate, auth: CanManageRoles, container: ContainerDep
) -> RoleResponse:
    clear_parent = "parent_role_id" in body.model_fields_set and body.parent_role_id is None
    changes = RoleChanges(
        name=body.name,
        description=body.description,
        permissions=body.permissions,
        parent_role_id=body.parent_role_id,
        clear_parent=clear_parent,
    )
    view = await container.roles.update(auth.principal, auth.org_id, role_id, changes)
    return RoleResponse.of(view)


@router.delete("/orgs/{org_id}/roles/{role_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_role(
    role_id: uuid.UUID, auth: CanManageRoles, container: ContainerDep
) -> Response:
    await container.roles.delete(auth.principal, auth.org_id, role_id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.get("/orgs/{org_id}/role-assignments", response_model=ListResponse[RoleAssignmentResponse])
async def list_role_assignments(
    auth: CanReadMembers,
    container: ContainerDep,
    user_id: Annotated[uuid.UUID | None, Query()] = None,
    project_id: Annotated[uuid.UUID | None, Query()] = None,
) -> ListResponse[RoleAssignmentResponse]:
    rows = await container.members.list_assignments(
        auth.org_id, user_id=user_id, project_id=project_id
    )
    return ListResponse(data=[RoleAssignmentResponse.of(row) for row in rows])


@router.post(
    "/orgs/{org_id}/role-assignments",
    status_code=status.HTTP_201_CREATED,
    response_model=RoleAssignmentResponse,
)
async def create_role_assignment(
    body: RoleAssignmentCreate, auth: CanManageMembers, container: ContainerDep
) -> RoleAssignmentResponse:
    assignment = await container.members.assign(
        auth.principal,
        auth.org_id,
        AssignmentRequest(user_id=body.user_id, role_id=body.role_id, project_id=body.project_id),
    )
    return RoleAssignmentResponse.of(assignment)


@router.delete(
    "/orgs/{org_id}/role-assignments/{assignment_id}", status_code=status.HTTP_204_NO_CONTENT
)
async def delete_role_assignment(
    assignment_id: uuid.UUID, auth: CanManageMembers, container: ContainerDep
) -> Response:
    await container.members.unassign(auth.principal, auth.org_id, assignment_id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)
