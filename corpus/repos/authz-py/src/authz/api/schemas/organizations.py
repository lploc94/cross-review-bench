"""Bodies of the organisation, member, role and role-assignment endpoints."""

from __future__ import annotations

import uuid
from datetime import datetime

from pydantic import Field, model_validator

from authz.api.schemas.common import RequestModel, ResponseModel
from authz.models import Organization, RoleAssignment
from authz.repositories.organizations import MemberRow, OrganizationWithRole
from authz.services.roles import RoleView


class OrganizationCreate(RequestModel):
    name: str = Field(min_length=1, max_length=200)
    slug: str | None = Field(default=None, min_length=1, max_length=48)


class OrganizationUpdate(RequestModel):
    name: str = Field(min_length=1, max_length=200)


class OrganizationResponse(ResponseModel):
    id: uuid.UUID
    name: str
    slug: str
    created_at: datetime
    updated_at: datetime

    @classmethod
    def of(cls, org: Organization) -> OrganizationResponse:
        return cls.model_validate(org)


class MyOrganizationResponse(OrganizationResponse):
    role: str

    @classmethod
    def mine(cls, row: OrganizationWithRole) -> MyOrganizationResponse:
        org = row.organization
        return cls(
            id=org.id,
            name=org.name,
            slug=org.slug,
            created_at=org.created_at,
            updated_at=org.updated_at,
            role=row.role_name,
        )


class OrganizationDetailResponse(OrganizationResponse):
    permissions: list[str]


class MemberResponse(ResponseModel):
    user_id: uuid.UUID
    email: str
    display_name: str
    role_id: uuid.UUID
    role: str
    joined_at: datetime

    @classmethod
    def of(cls, row: MemberRow) -> MemberResponse:
        return cls(
            user_id=row.user.id,
            email=row.user.email,
            display_name=row.user.display_name,
            role_id=row.role.id,
            role=row.role.name,
            joined_at=row.membership.created_at,
        )


class MemberUpdate(RequestModel):
    role_id: uuid.UUID


class RoleCreate(RequestModel):
    name: str = Field(min_length=1, max_length=50)
    description: str = Field(default="", max_length=500)
    permissions: list[str] = Field(default_factory=list, max_length=100)
    parent_role_id: uuid.UUID | None = None


class RoleUpdate(RequestModel):
    """Only the fields present change; `parent_role_id: null` removes the parent."""

    name: str | None = Field(default=None, min_length=1, max_length=50)
    description: str | None = Field(default=None, max_length=500)
    permissions: list[str] | None = Field(default=None, max_length=100)
    parent_role_id: uuid.UUID | None = None

    @model_validator(mode="after")
    def _not_empty(self) -> RoleUpdate:
        if not self.model_fields_set:
            raise ValueError("nothing to change")
        return self


class RoleResponse(ResponseModel):
    id: uuid.UUID
    name: str
    description: str
    builtin: bool
    parent_role_id: uuid.UUID | None
    permissions: list[str]
    effective_permissions: list[str]
    created_at: datetime
    updated_at: datetime

    @classmethod
    def of(cls, view: RoleView) -> RoleResponse:
        role = view.role
        return cls(
            id=role.id,
            name=role.name,
            description=role.description,
            builtin=role.builtin,
            parent_role_id=role.parent_role_id,
            permissions=sorted(view.permissions),
            effective_permissions=sorted(view.effective_permissions),
            created_at=role.created_at,
            updated_at=role.updated_at,
        )


class RoleAssignmentCreate(RequestModel):
    user_id: uuid.UUID
    role_id: uuid.UUID
    project_id: uuid.UUID | None = None


class RoleAssignmentResponse(ResponseModel):
    id: uuid.UUID
    user_id: uuid.UUID
    role_id: uuid.UUID
    project_id: uuid.UUID | None
    created_by: uuid.UUID | None
    created_at: datetime

    @classmethod
    def of(cls, assignment: RoleAssignment) -> RoleAssignmentResponse:
        return cls.model_validate(assignment)


class PermissionResponse(ResponseModel):
    name: str
    description: str
    project_scoped: bool
