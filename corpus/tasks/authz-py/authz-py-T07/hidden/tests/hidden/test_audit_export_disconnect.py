"""A client that goes away in the middle of an export gives its database connection back."""

from __future__ import annotations

import asyncio
import gc
import uuid
from datetime import timedelta
from typing import Any

import pytest

from authz.config import Settings
from authz.repositories.audit import AuditRepository
from tests.conftest import make_settings
from tests.helpers.factories import org_with_member

PAGE_SIZE = 10


@pytest.fixture
def settings(migrated_database: str, redis_url: str) -> Settings:
    return make_settings(migrated_database, redis_url, audit_export_page_size=PAGE_SIZE)


async def _add_events(container, org_id: uuid.UUID, actor_id: uuid.UUID, count: int) -> None:
    now = container.clock.now()
    async with container.db.transaction() as session:
        audit = AuditRepository(session)
        for number in range(count):
            await audit.append(
                org_id=org_id,
                actor_id=actor_id,
                action="project.created",
                target_type="project",
                target_id=str(number),
                data={"name": f"Project {number}"},
                ip=None,
                created_at=now + timedelta(seconds=number + 1),
            )


def _scope(path: str, token: str) -> dict[str, Any]:
    return {
        "type": "http",
        "asgi": {"version": "3.0", "spec_version": "2.3"},
        "http_version": "1.1",
        "method": "GET",
        "scheme": "http",
        "path": path,
        "raw_path": path.encode(),
        "root_path": "",
        "query_string": b"",
        "headers": [(b"host", b"authz.test"), (b"authorization", f"Bearer {token}".encode())],
        "client": ("198.51.100.30", 50000),
        "server": ("authz.test", 80),
    }


async def test_export_abandoned_by_its_client_returns_its_connection(
    app, client, container, monkeypatch
):
    org, owner, _ = await org_with_member(client, container, "viewer")
    org_id = uuid.UUID(org["id"])
    await _add_events(container, org_id, owner.id, 3 * PAGE_SIZE)

    second_page = asyncio.Event()
    released = asyncio.Event()
    disconnected = asyncio.Event()
    calls = 0
    original_page = AuditRepository.page

    async def slow_second_page(self, *args: Any, **kwargs: Any):
        nonlocal calls
        calls += 1
        if calls == 2:
            # The client goes away while the export waits for its second page.
            second_page.set()
            await released.wait()
        return await original_page(self, *args, **kwargs)

    monkeypatch.setattr(AuditRepository, "page", slow_second_page)
    received: list[bytes] = []
    requested = False

    async def receive() -> dict[str, Any]:
        nonlocal requested
        if not requested:
            requested = True
            return {"type": "http.request", "body": b"", "more_body": False}
        await disconnected.wait()
        return {"type": "http.disconnect"}

    async def send(message: dict[str, Any]) -> None:
        if message["type"] == "http.response.body":
            received.append(message.get("body", b""))

    # Nothing may close a forgotten session behind the export's back while the test looks.
    gc.disable()
    try:
        request = asyncio.create_task(
            app(_scope(f"/v1/orgs/{org_id}/audit/export", owner.access_token), receive, send)
        )
        await asyncio.wait_for(second_page.wait(), timeout=10)
        disconnected.set()
        await asyncio.wait_for(request, timeout=10)
        assert b"".join(received).count(b"\n") == PAGE_SIZE

        for _ in range(200):
            if container.db.engine.pool.checkedout() == 0:
                break
            await asyncio.sleep(0.01)
        assert container.db.engine.pool.checkedout() == 0
    finally:
        released.set()
        gc.enable()
