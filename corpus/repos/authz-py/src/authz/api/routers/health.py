"""Liveness and dependency health."""

from __future__ import annotations

from fastapi import APIRouter
from fastapi.responses import JSONResponse

from authz.api.deps import ContainerDep

router = APIRouter(tags=["health"])


@router.get("/health")
async def health(container: ContainerDep) -> JSONResponse:
    """200 when PostgreSQL and Redis answer, 503 with the failing checks otherwise."""
    report = await container.health.report()
    return JSONResponse(
        {"status": "ok" if report.healthy else "degraded", "checks": report.checks},
        status_code=200 if report.healthy else 503,
    )
