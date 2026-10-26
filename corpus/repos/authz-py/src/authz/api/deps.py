"""FastAPI dependencies: the container, the caller, organisation membership and permissions."""

from __future__ import annotations

import uuid
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Annotated

from fastapi import Depends, Path, Request

from authz.container import Container
from authz.domain.permissions import Permission
from authz.domain.principal import Principal, Resource
from authz.errors import AuthenticationFailed, NotFoundError
from authz.models import Membership
from authz.services.auth import ClientInfo


def get_container(request: Request) -> Container:
    container: Container = request.app.state.container
    return container


ContainerDep = Annotated[Container, Depends(get_container)]


def get_client(request: Request) -> ClientInfo:
    ip = getattr(request.state, "client_ip", None)
    if ip is None and request.client is not None:
        ip = request.client.host
    return ClientInfo(ip=ip, user_agent=request.headers.get("user-agent"))


ClientDep = Annotated[ClientInfo, Depends(get_client)]


def bearer_token(request: Request) -> str:
    header = request.headers.get("authorization", "")
    scheme, _, token = header.partition(" ")
    if scheme.lower() != "bearer" or not token.strip():
        raise AuthenticationFailed("a bearer token is required")
    return token.strip()


async def current_principal(
    request: Request, container: ContainerDep, client: ClientDep
) -> Principal:
    principal = await container.auth.authenticate(bearer_token(request), client)
    request.state.principal = principal
    return principal


PrincipalDep = Annotated[Principal, Depends(current_principal)]


@dataclass(frozen=True, slots=True)
class OrgContext:
    """A caller inside an organisation it belongs to."""

    principal: Principal
    org_id: uuid.UUID
    membership: Membership


async def org_context(
    org_id: Annotated[uuid.UUID, Path()],
    principal: PrincipalDep,
    container: ContainerDep,
) -> OrgContext:
    """Resolve the caller's membership first; non-members get 404 so ids leak nothing."""
    membership = await container.members.membership(org_id, principal.user_id)
    if membership is None:
        raise NotFoundError("organization")
    return OrgContext(principal=principal, org_id=org_id, membership=membership)


OrgContextDep = Annotated[OrgContext, Depends(org_context)]

ResourceResolver = Callable[[OrgContext, Request, Container], Awaitable[Resource]]


async def org_scope(ctx: OrgContext, _: Request, __: Container) -> Resource:
    return Resource(org_id=ctx.org_id)


def project_scope(param: str = "project_id") -> ResourceResolver:
    """The project named by a path parameter; 404 when it is not in the organisation."""

    async def resolve(ctx: OrgContext, request: Request, container: Container) -> Resource:
        try:
            project_id = uuid.UUID(str(request.path_params[param]))
        except (KeyError, ValueError):
            raise NotFoundError("project") from None
        await container.projects.get(ctx.org_id, project_id)
        return Resource(org_id=ctx.org_id, project_id=project_id)

    return resolve


@dataclass(frozen=True, slots=True)
class Authorized:
    """Proof that the caller holds a permission on a resource; route handlers receive it."""

    ctx: OrgContext
    resource: Resource
    permission: Permission

    @property
    def principal(self) -> Principal:
        return self.ctx.principal

    @property
    def org_id(self) -> uuid.UUID:
        return self.ctx.org_id


def require(
    permission: Permission, resource_from: ResourceResolver = org_scope
) -> Callable[..., Awaitable[Authorized]]:
    """A dependency that lets the request through only if the caller holds `permission`."""

    async def dependency(
        request: Request, ctx: OrgContextDep, container: ContainerDep
    ) -> Authorized:
        resource = await resource_from(ctx, request, container)
        await container.authz.enforce(ctx.principal, permission, resource)
        return Authorized(ctx=ctx, resource=resource, permission=permission)

    dependency.__name__ = f"require_{permission.value.replace(':', '_')}"
    return dependency
