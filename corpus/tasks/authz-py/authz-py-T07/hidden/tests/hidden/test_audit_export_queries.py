"""An export issues a bounded number of queries per page, however many actors it names."""

from __future__ import annotations

import uuid
from datetime import timedelta

import pytest
from sqlalchemy import event

from authz.config import Settings
from authz.repositories.audit import AuditRepository
from tests.conftest import make_settings
from tests.helpers.factories import make_user, org_with_member

PAGE_SIZE = 10
EVENTS = 50
ACTORS = 12


@pytest.fixture
def settings(migrated_database: str, redis_url: str) -> Settings:
    return make_settings(migrated_database, redis_url, audit_export_page_size=PAGE_SIZE)


async def test_export_looks_actors_up_once_per_page(client, container):
    org, _, _ = await org_with_member(client, container, "viewer")
    org_id = uuid.UUID(org["id"])
    actors = [await make_user(container, name=f"Actor {n}") for n in range(ACTORS)]
    now = container.clock.now()
    async with container.db.transaction() as session:
        audit = AuditRepository(session)
        for number in range(EVENTS):
            await audit.append(
                org_id=org_id,
                actor_id=actors[number % ACTORS].id,
                action="project.updated",
                target_type="project",
                target_id=str(number),
                data={"number": number},
                ip=None,
                created_at=now + timedelta(seconds=number + 1),
            )

    statements: list[str] = []

    def count(conn, cursor, statement, parameters, context, executemany) -> None:
        statements.append(statement)

    engine = container.db.engine.sync_engine
    event.listen(engine, "before_cursor_execute", count)
    try:
        exported = [item async for item in container.audit.export(org_id, action="project.updated")]
    finally:
        event.remove(engine, "before_cursor_execute", count)

    assert len(exported) == EVENTS
    emails = {actor.id: actor.email for actor in actors}
    for item in exported:
        assert item.event.actor_id is not None
        assert item.actor_email == emails[item.event.actor_id]
    pages = EVENTS // PAGE_SIZE + 1
    assert len(statements) <= 2 * pages + 2, statements
