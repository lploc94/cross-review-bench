from __future__ import annotations

from authz.services.health import HealthService


async def test_health_reports_ok(client):
    response = await client.get("/health")

    assert response.status_code == 200
    assert response.json() == {"status": "ok", "checks": {"database": "ok", "redis": "ok"}}


async def test_health_reports_a_failing_dependency(client, container):
    async def broken() -> None:
        raise ConnectionError("redis is down")

    async def fine() -> None:
        return None

    container.health = HealthService({"database": fine, "redis": broken})

    response = await client.get("/health")

    assert response.status_code == 503
    assert response.json() == {"status": "degraded", "checks": {"database": "ok", "redis": "error"}}
