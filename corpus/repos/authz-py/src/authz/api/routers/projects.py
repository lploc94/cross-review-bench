"""Projects inside an organisation."""

from __future__ import annotations

import uuid
from typing import Annotated

from fastapi import APIRouter, Depends, Query, Response, status

from authz.api.deps import Authorized, ContainerDep, OrgContextDep, project_scope, require
from authz.api.schemas.common import PageResponse
from authz.api.schemas.resources import ProjectCreate, ProjectResponse, ProjectUpdate
from authz.domain.permissions import Permission
from authz.services.projects import ProjectChanges

router = APIRouter(prefix="/v1/orgs/{org_id}/projects", tags=["projects"])

CanCreateProject = Annotated[Authorized, Depends(require(Permission.PROJECTS_WRITE))]
CanReadProject = Annotated[
    Authorized, Depends(require(Permission.PROJECTS_READ, resource_from=project_scope()))
]
CanWriteProject = Annotated[
    Authorized, Depends(require(Permission.PROJECTS_WRITE, resource_from=project_scope()))
]
CanDeleteProject = Annotated[
    Authorized, Depends(require(Permission.PROJECTS_DELETE, resource_from=project_scope()))
]


@router.get("", response_model=PageResponse[ProjectResponse])
async def list_projects(
    ctx: OrgContextDep,
    container: ContainerDep,
    include_archived: bool = False,
    cursor: Annotated[str | None, Query(max_length=512)] = None,
    limit: Annotated[int | None, Query(ge=1, le=200)] = None,
) -> PageResponse[ProjectResponse]:
    """Every project the caller may read: all of them with organisation-wide projects:read,
    otherwise those granted through project role assignments."""
    page = await container.projects.page(
        ctx.principal,
        ctx.org_id,
        include_archived=include_archived,
        cursor=cursor,
        limit=limit,
    )
    return PageResponse(
        data=[ProjectResponse.of(project) for project in page.items],
        next_cursor=page.next_cursor,
    )


@router.post("", status_code=status.HTTP_201_CREATED, response_model=ProjectResponse)
async def create_project(
    body: ProjectCreate, auth: CanCreateProject, container: ContainerDep
) -> ProjectResponse:
    project = await container.projects.create(
        auth.principal, auth.org_id, name=body.name, description=body.description
    )
    return ProjectResponse.of(project)


@router.get("/{project_id}", response_model=ProjectResponse)
async def get_project(
    project_id: uuid.UUID, auth: CanReadProject, container: ContainerDep
) -> ProjectResponse:
    return ProjectResponse.of(await container.projects.get(auth.org_id, project_id))


@router.patch("/{project_id}", response_model=ProjectResponse)
async def update_project(
    project_id: uuid.UUID, body: ProjectUpdate, auth: CanWriteProject, container: ContainerDep
) -> ProjectResponse:
    project = await container.projects.update(
        auth.principal,
        auth.org_id,
        project_id,
        ProjectChanges(name=body.name, description=body.description, archived=body.archived),
    )
    return ProjectResponse.of(project)


@router.delete("/{project_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_project(
    project_id: uuid.UUID, auth: CanDeleteProject, container: ContainerDep
) -> Response:
    await container.projects.delete(auth.principal, auth.org_id, project_id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)
