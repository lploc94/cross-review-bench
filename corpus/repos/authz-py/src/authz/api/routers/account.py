"""The caller's own account: profile and login sessions."""

from __future__ import annotations

import uuid

from fastapi import APIRouter, Response, status

from authz.api.deps import ContainerDep, PrincipalDep
from authz.api.schemas.auth import ProfileUpdate, SessionResponse, UserResponse
from authz.api.schemas.common import ListResponse

router = APIRouter(prefix="/v1", tags=["account"])


@router.get("/me", response_model=UserResponse)
async def me(principal: PrincipalDep, container: ContainerDep) -> UserResponse:
    return UserResponse.of(await container.users.get(principal.user_id))


@router.patch("/me", response_model=UserResponse)
async def update_me(
    body: ProfileUpdate, principal: PrincipalDep, container: ContainerDep
) -> UserResponse:
    user = await container.users.update_profile(principal, display_name=body.display_name)
    return UserResponse.of(user)


@router.get("/sessions", response_model=ListResponse[SessionResponse])
async def list_sessions(
    principal: PrincipalDep, container: ContainerDep
) -> ListResponse[SessionResponse]:
    views = await container.sessions.list_own(principal)
    return ListResponse(data=[SessionResponse.of(view) for view in views])


@router.delete("/sessions/{session_id}", status_code=status.HTTP_204_NO_CONTENT)
async def revoke_session(
    session_id: uuid.UUID, principal: PrincipalDep, container: ContainerDep
) -> Response:
    await container.sessions.revoke_own(principal, session_id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)
