"""Bodies of the authentication, profile and session endpoints."""

from __future__ import annotations

import uuid
from datetime import datetime

from pydantic import Field

from authz.api.schemas.common import RequestModel, ResponseModel
from authz.models import User
from authz.services.auth import TokenPair
from authz.services.users import SessionView


class LoginRequest(RequestModel):
    email: str = Field(min_length=3, max_length=320)
    password: str = Field(min_length=1, max_length=1024)
    device_label: str | None = Field(default=None, max_length=100)


class RefreshRequest(RequestModel):
    refresh_token: str = Field(min_length=1, max_length=512)


class TokenResponse(ResponseModel):
    access_token: str
    token_type: str = "bearer"  # noqa: S105 - the OAuth token type, not a secret
    expires_in: int
    refresh_token: str
    session_id: uuid.UUID
    user_id: uuid.UUID

    @classmethod
    def of(cls, pair: TokenPair) -> TokenResponse:
        return cls(
            access_token=pair.access.token,
            expires_in=pair.access.expires_in,
            refresh_token=pair.refresh_token,
            session_id=pair.session_id,
            user_id=pair.user_id,
        )


class UserResponse(ResponseModel):
    id: uuid.UUID
    email: str
    display_name: str
    created_at: datetime

    @classmethod
    def of(cls, user: User) -> UserResponse:
        return cls.model_validate(user)


class ProfileUpdate(RequestModel):
    display_name: str = Field(max_length=200)


class SessionResponse(ResponseModel):
    id: uuid.UUID
    device_label: str | None
    ip: str | None
    user_agent: str | None
    created_at: datetime
    last_used_at: datetime
    expires_at: datetime
    current: bool

    @classmethod
    def of(cls, view: SessionView) -> SessionResponse:
        row = view.session
        return cls(
            id=row.id,
            device_label=row.device_label,
            ip=row.ip,
            user_agent=row.user_agent,
            created_at=row.created_at,
            last_used_at=row.last_used_at,
            expires_at=row.expires_at,
            current=view.current,
        )
