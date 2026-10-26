"""Domain errors. The API layer maps each class to an HTTP status in one exception handler."""

from __future__ import annotations

from typing import Any


class DomainError(Exception):
    """Base class of every error the service reports to its clients."""

    code = "domain_error"
    default_message = "the request could not be completed"

    def __init__(self, message: str | None = None, *, details: dict[str, Any] | None = None):
        self.message = message or self.default_message
        self.details = details or {}
        super().__init__(self.message)

    def to_dict(self) -> dict[str, Any]:
        body: dict[str, Any] = {"code": self.code, "message": self.message}
        if self.details:
            body["details"] = self.details
        return body


class InvalidInputError(DomainError):
    code = "invalid_input"
    default_message = "the request is not valid"


class NotFoundError(DomainError):
    code = "not_found"
    default_message = "the resource does not exist"

    def __init__(self, resource: str, message: str | None = None) -> None:
        self.resource = resource
        super().__init__(message or f"{resource} not found", details={"resource": resource})


class ConflictError(DomainError):
    code = "conflict"
    default_message = "the request conflicts with the current state"


class GoneError(DomainError):
    code = "gone"
    default_message = "the resource is no longer available"


class AuthenticationFailed(DomainError):
    code = "authentication_failed"
    default_message = "authentication failed"


class InvalidCredentials(AuthenticationFailed):
    code = "invalid_credentials"
    default_message = "the email or password is incorrect"


class InvalidToken(AuthenticationFailed):
    code = "invalid_token"
    default_message = "the token is invalid or has expired"


class PermissionDenied(DomainError):
    code = "permission_denied"
    default_message = "you are not allowed to do this"


class RateLimited(DomainError):
    code = "rate_limited"
    default_message = "too many requests"

    def __init__(self, retry_after: int, message: str | None = None) -> None:
        self.retry_after = max(1, retry_after)
        super().__init__(message, details={"retry_after": self.retry_after})


class ServiceUnavailable(DomainError):
    code = "service_unavailable"
    default_message = "a dependency of the service is unavailable"
