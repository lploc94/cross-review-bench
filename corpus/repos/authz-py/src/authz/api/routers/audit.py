"""The audit log of an organisation."""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, Query

from authz.api.deps import Authorized, ContainerDep, require
from authz.api.schemas.common import PageResponse
from authz.api.schemas.resources import AuditEventResponse
from authz.domain.permissions import Permission

router = APIRouter(tags=["audit"])

CanReadAudit = Annotated[Authorized, Depends(require(Permission.AUDIT_READ))]


@router.get("/v1/orgs/{org_id}/audit", response_model=PageResponse[AuditEventResponse])
async def list_audit_events(
    auth: CanReadAudit,
    container: ContainerDep,
    cursor: Annotated[str | None, Query(max_length=512)] = None,
    limit: Annotated[int | None, Query(ge=1, le=200)] = None,
    action: Annotated[str | None, Query(max_length=100)] = None,
) -> PageResponse[AuditEventResponse]:
    """Newest first. Pass `next_cursor` back as `cursor` for the following page."""
    page = await container.audit.page(auth.org_id, cursor=cursor, limit=limit, action=action)
    return PageResponse(
        data=[AuditEventResponse.of(event) for event in page.items],
        next_cursor=page.next_cursor,
    )
