"""Request id, client address and one access-log line per request."""

from __future__ import annotations

import re
import time
import uuid
from typing import Any

from starlette.datastructures import Headers, MutableHeaders
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from authz.logging import bind_request_context, get_logger

log = get_logger("authz.access")

REQUEST_ID_HEADER = "x-request-id"
_REQUEST_ID = re.compile(r"^[A-Za-z0-9._-]{1,64}$")


def route_template(scope: Scope) -> str:
    """The matched route's path template; raw paths may carry tokens and are never logged."""
    route = scope.get("route")
    path = getattr(route, "path", None)
    return path if isinstance(path, str) else "<unmatched>"


def client_ip(scope: Scope, *, trust_proxy_headers: bool) -> str | None:
    if trust_proxy_headers:
        forwarded = Headers(scope=scope).get("x-forwarded-for")
        if forwarded:
            first = forwarded.split(",")[0].strip()
            if first:
                return first
    client = scope.get("client")
    return client[0] if client else None


class RequestContextMiddleware:
    """Pure ASGI middleware: assigns the request id, binds log context and logs the outcome."""

    def __init__(self, app: ASGIApp, *, trust_proxy_headers: bool = False) -> None:
        self.app = app
        self.trust_proxy_headers = trust_proxy_headers

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        incoming = Headers(scope=scope).get(REQUEST_ID_HEADER, "")
        request_id = incoming if _REQUEST_ID.match(incoming) else uuid.uuid4().hex
        ip = client_ip(scope, trust_proxy_headers=self.trust_proxy_headers)
        state: dict[str, Any] = scope.setdefault("state", {})
        state["request_id"] = request_id
        state["client_ip"] = ip
        bind_request_context({"request_id": request_id})
        started = time.perf_counter()
        status = 500

        async def send_with_id(message: Message) -> None:
            nonlocal status
            if message["type"] == "http.response.start":
                status = message["status"]
                MutableHeaders(scope=message).append("X-Request-ID", request_id)
            await send(message)

        try:
            await self.app(scope, receive, send_with_id)
        finally:
            log.info(
                "request.completed",
                method=scope.get("method"),
                route=route_template(scope),
                status=status,
                duration_ms=round((time.perf_counter() - started) * 1000, 1),
                client_ip=ip,
            )
