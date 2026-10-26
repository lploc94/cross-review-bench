"""The one place where errors become HTTP responses.

Every error body has the shape {"error": {"code", "message", "details"?}}.
"""

from __future__ import annotations

from typing import Any

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

from authz.api.middleware import route_template
from authz.errors import (
    AuthenticationFailed,
    ConflictError,
    DomainError,
    GoneError,
    InvalidInputError,
    NotFoundError,
    PermissionDenied,
    RateLimited,
    ServiceUnavailable,
)
from authz.logging import get_logger

log = get_logger(__name__)

STATUS_BY_ERROR: dict[type[DomainError], int] = {
    InvalidInputError: 422,
    AuthenticationFailed: 401,
    PermissionDenied: 403,
    NotFoundError: 404,
    ConflictError: 409,
    GoneError: 410,
    RateLimited: 429,
    ServiceUnavailable: 503,
}

HTTP_CODES = {
    400: "bad_request",
    401: "authentication_failed",
    403: "permission_denied",
    404: "not_found",
    405: "method_not_allowed",
    409: "conflict",
    413: "payload_too_large",
    415: "unsupported_media_type",
    429: "rate_limited",
}


def status_for(error: DomainError) -> int:
    """The status of the nearest mapped class in the error's hierarchy (400 if none)."""
    for cls in type(error).__mro__:
        status = STATUS_BY_ERROR.get(cls)
        if status is not None:
            return status
    return 400


def error_body(code: str, message: str, details: dict[str, Any] | None = None) -> dict[str, Any]:
    error: dict[str, Any] = {"code": code, "message": message}
    if details:
        error["details"] = details
    return {"error": error}


async def handle_domain_error(_: Request, error: Exception) -> JSONResponse:
    assert isinstance(error, DomainError)  # noqa: S101 - registered for DomainError only
    status = status_for(error)
    headers: dict[str, str] = {}
    if isinstance(error, RateLimited):
        headers["Retry-After"] = str(error.retry_after)
    if isinstance(error, AuthenticationFailed):
        headers["WWW-Authenticate"] = 'Bearer realm="authz"'
    if status >= 500:
        log.error("request.dependency_failed", code=error.code)
    return JSONResponse(
        error_body(error.code, error.message, error.details), status_code=status, headers=headers
    )


async def handle_validation_error(_: Request, error: Exception) -> JSONResponse:
    assert isinstance(error, RequestValidationError)  # noqa: S101
    problems = [
        {
            "field": ".".join(str(part) for part in item.get("loc", ()) if part != "body"),
            "message": item.get("msg", "invalid value"),
        }
        for item in error.errors()
    ]
    return JSONResponse(
        error_body("validation_error", "the request is not valid", {"problems": problems}),
        status_code=422,
    )


async def handle_http_error(_: Request, error: Exception) -> JSONResponse:
    assert isinstance(error, StarletteHTTPException)  # noqa: S101
    code = HTTP_CODES.get(error.status_code, "error")
    message = error.detail if isinstance(error.detail, str) else code.replace("_", " ")
    return JSONResponse(
        error_body(code, message),
        status_code=error.status_code,
        headers=dict(error.headers or {}),
    )


async def handle_unexpected(request: Request, error: Exception) -> JSONResponse:
    log.error(
        "request.unhandled_error",
        route=route_template(request.scope),
        error=type(error).__name__,
        exc_info=error,
    )
    return JSONResponse(
        error_body("internal_error", "something went wrong on our side"), status_code=500
    )


def install_error_handlers(app: FastAPI) -> None:
    app.add_exception_handler(DomainError, handle_domain_error)
    app.add_exception_handler(RequestValidationError, handle_validation_error)
    app.add_exception_handler(StarletteHTTPException, handle_http_error)
    app.add_exception_handler(Exception, handle_unexpected)
