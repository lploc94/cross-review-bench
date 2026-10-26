from __future__ import annotations

import asyncio
import uuid

import pytest
from sqlalchemy import func, select

from authz.domain.principal import Actor, Principal
from authz.models import AuditEvent, Project
from authz.repositories.organizations import OrganizationRepository
from authz.services.audit import AuditAction
from tests.helpers.factories import make_user


async def _org(container, owner):
    created = await container.organizations.create(
        owner.id, name="Initech", actor=Actor(user_id=owner.id, ip=None)
    )
    return created.organization


async def test_audit_write_and_change_commit_together(container, monkeypatch):
    owner = await make_user(container)
    org = await _org(container, owner)
    principal = Principal.user(owner.id, None, ip="198.51.100.1")

    async def failing_record(*args, **kwargs):
        raise RuntimeError("audit storage unavailable")

    monkeypatch.setattr(container.audit_log, "record", failing_record)

    with pytest.raises(RuntimeError):
        await container.projects.create(principal, org.id, name="Ghost", description="")

    async with container.db.read() as session:
        projects = await session.scalar(select(func.count()).select_from(Project))
    assert projects == 0


async def test_record_serialises_ids_and_sets(container):
    owner = await make_user(container)
    org = await _org(container, owner)
    target = uuid.uuid4()

    async with container.db.transaction() as session:
        await container.audit_log.record(
            session,
            Actor(user_id=owner.id, ip="192.0.2.5"),
            org_id=org.id,
            action=AuditAction.ROLE_UPDATED,
            target_type="role",
            target_id=target,
            data={"permissions_added": frozenset({"b:x", "a:y"}), "parent": target},
        )

    async with container.db.read() as session:
        event = (
            await session.execute(
                select(AuditEvent).where(AuditEvent.action == AuditAction.ROLE_UPDATED.value)
            )
        ).scalar_one()
    assert event.target_id == str(target)
    assert event.data == {"permissions_added": ["a:y", "b:x"], "parent": str(target)}
    assert event.created_at == container.clock.now()
    assert event.ip == "192.0.2.5"


async def test_system_actor_has_no_user(container):
    owner = await make_user(container)
    created = await container.organizations.create(owner.id, name="Hooli", actor=Actor.system())

    async with container.db.read() as session:
        event = (
            await session.execute(
                select(AuditEvent).where(AuditEvent.org_id == created.organization.id)
            )
        ).scalar_one()
    assert event.action == "org.created"
    assert event.actor_id is None
    assert event.data["owner_id"] == str(owner.id)


async def test_audit_write_is_not_blocked_by_the_organisation_lock(container):
    """Changes that lock the organisation row must not block a change that only writes its
    audit event (the foreign key check), or the two can deadlock."""
    owner = await make_user(container)
    org = await _org(container, owner)
    locked = asyncio.Event()
    release = asyncio.Event()

    async def hold_lock() -> None:
        async with container.db.transaction() as session:
            await OrganizationRepository(session).lock(org.id)
            locked.set()
            await release.wait()

    holder = asyncio.create_task(hold_lock())
    await asyncio.wait_for(locked.wait(), timeout=10)
    try:

        async def write_event() -> None:
            async with container.db.transaction() as session:
                await container.audit_log.record(
                    session,
                    Actor(user_id=owner.id, ip=None),
                    org_id=org.id,
                    action=AuditAction.ROLE_UPDATED,
                    target_type="role",
                    target_id=uuid.uuid4(),
                    data={},
                )

        await asyncio.wait_for(write_event(), timeout=5)
    finally:
        release.set()
        await holder
