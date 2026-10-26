"""Bodies of the project, invitation and audit endpoints."""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any

from pydantic import Field, model_validator

from authz.api.schemas.common import RequestModel, ResponseModel
from authz.models import AuditEvent, Invitation, Project


class ProjectCreate(RequestModel):
    name: str = Field(min_length=1, max_length=200)
    description: str = Field(default="", max_length=2000)


class ProjectUpdate(RequestModel):
    name: str | None = Field(default=None, min_length=1, max_length=200)
    description: str | None = Field(default=None, max_length=2000)
    archived: bool | None = None

    @model_validator(mode="after")
    def _not_empty(self) -> ProjectUpdate:
        if self.name is None and self.description is None and self.archived is None:
            raise ValueError("nothing to change")
        return self


class ProjectResponse(ResponseModel):
    id: uuid.UUID
    org_id: uuid.UUID
    name: str
    description: str
    created_by: uuid.UUID | None
    created_at: datetime
    updated_at: datetime
    archived_at: datetime | None

    @classmethod
    def of(cls, project: Project) -> ProjectResponse:
        return cls.model_validate(project)


class InvitationCreate(RequestModel):
    email: str = Field(min_length=3, max_length=320)
    role_id: uuid.UUID


class InvitationResponse(ResponseModel):
    id: uuid.UUID
    org_id: uuid.UUID
    email: str
    role_id: uuid.UUID
    invited_by: uuid.UUID | None
    created_at: datetime
    expires_at: datetime
    accepted_at: datetime | None

    @classmethod
    def of(cls, invitation: Invitation) -> InvitationResponse:
        return cls.model_validate(invitation)


class AcceptedInvitationResponse(ResponseModel):
    org_id: uuid.UUID
    role_id: uuid.UUID
    user_id: uuid.UUID
    joined_at: datetime


class AuditEventResponse(ResponseModel):
    id: int
    actor_id: uuid.UUID | None
    action: str
    target_type: str
    target_id: str | None
    data: dict[str, Any]
    ip: str | None
    created_at: datetime

    @classmethod
    def of(cls, event: AuditEvent) -> AuditEventResponse:
        return cls.model_validate(event)
