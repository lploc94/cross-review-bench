"""Login, refresh and logout."""

from __future__ import annotations

from dataclasses import replace

from fastapi import APIRouter, Response, status

from authz.api.deps import ClientDep, ContainerDep, PrincipalDep
from authz.api.schemas.auth import LoginRequest, RefreshRequest, TokenResponse

router = APIRouter(prefix="/v1", tags=["auth"])

NO_STORE = {"Cache-Control": "no-store", "Pragma": "no-cache"}


@router.post("/auth/login", response_model=TokenResponse)
async def login(
    body: LoginRequest, container: ContainerDep, client: ClientDep, response: Response
) -> TokenResponse:
    pair = await container.auth.login(
        body.email, body.password, replace(client, device_label=body.device_label)
    )
    response.headers.update(NO_STORE)
    return TokenResponse.of(pair)


@router.post("/auth/refresh", response_model=TokenResponse)
async def refresh(
    body: RefreshRequest, container: ContainerDep, client: ClientDep, response: Response
) -> TokenResponse:
    pair = await container.auth.refresh(body.refresh_token, client)
    response.headers.update(NO_STORE)
    return TokenResponse.of(pair)


@router.post("/auth/logout", status_code=status.HTTP_204_NO_CONTENT)
async def logout(principal: PrincipalDep, container: ContainerDep) -> Response:
    await container.auth.logout(principal)
    return Response(status_code=status.HTTP_204_NO_CONTENT)
