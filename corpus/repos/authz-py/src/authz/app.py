"""The FastAPI application."""

from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI

from authz import __version__
from authz.api.errors import install_error_handlers
from authz.api.middleware import RequestContextMiddleware
from authz.api.routers import account, audit, auth, health, invitations, organizations, projects
from authz.api.routers import roles as roles_router
from authz.config import load_settings
from authz.container import Container, build_container
from authz.logging import configure_logging, get_logger

log = get_logger(__name__)


def create_app(container: Container) -> FastAPI:
    """Wire the routers to a container. The app closes the container when it shuts down."""

    @asynccontextmanager
    async def lifespan(_: FastAPI) -> AsyncIterator[None]:
        log.info("app.started", version=__version__, environment=container.settings.environment)
        try:
            yield
        finally:
            await container.aclose()
            log.info("app.stopped")

    docs = container.settings.environment != "production"
    app = FastAPI(
        title="authz",
        version=__version__,
        lifespan=lifespan,
        docs_url="/docs" if docs else None,
        redoc_url=None,
        openapi_url="/openapi.json" if docs else None,
    )
    app.state.container = container
    app.add_middleware(
        RequestContextMiddleware, trust_proxy_headers=container.settings.trust_proxy_headers
    )
    install_error_handlers(app)
    for module in (
        health,
        auth,
        account,
        organizations,
        roles_router,
        projects,
        invitations,
        audit,
    ):
        app.include_router(module.router)
    return app


def create_app_from_env() -> FastAPI:
    """Entry point for `uvicorn --factory authz.app:create_app_from_env`."""
    settings = load_settings()
    configure_logging(settings.log_level)
    return create_app(build_container(settings))
