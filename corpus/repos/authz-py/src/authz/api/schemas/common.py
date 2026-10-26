"""Shared schema pieces."""

from __future__ import annotations

from pydantic import BaseModel, ConfigDict


class RequestModel(BaseModel):
    """Request bodies reject unknown fields, so typos fail loudly."""

    model_config = ConfigDict(extra="forbid", str_max_length=10_000)


class ResponseModel(BaseModel):
    model_config = ConfigDict(from_attributes=True)


class ListResponse[T](BaseModel):
    data: list[T]


class PageResponse[T](BaseModel):
    data: list[T]
    next_cursor: str | None = None
