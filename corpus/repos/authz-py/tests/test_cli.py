from __future__ import annotations

import asyncio
import io
import json

import pytest

from authz import cli
from authz.container import build_container


@pytest.fixture
def run_cli(settings, clock, random_source, mailer, container):
    """Run the CLI in a worker thread with its own container (it owns its event loop)."""

    async def run(*argv: str, stdin: str = ""):
        out, err = io.StringIO(), io.StringIO()
        own = build_container(settings, clock=clock, random=random_source, mailer=mailer)

        def call() -> int:
            return cli.main(
                list(argv), stdin=io.StringIO(stdin), stdout=out, stderr=err, container=own
            )

        code = await asyncio.to_thread(call)
        return code, out.getvalue(), err.getvalue()

    return run


async def test_create_user_reads_the_password_from_stdin(run_cli, container):
    code, out, _ = await run_cli(
        "create-user",
        "--email",
        "Vera@Example.com",
        "--name",
        "Vera",
        "--password-stdin",
        stdin="a sturdy password\n",
    )

    assert code == 0
    assert json.loads(out)["email"] == "vera@example.com"
    user = await container.users.get_by_email("vera@example.com")
    assert user is not None
    assert await container.hasher.verify(user.password_hash, "a sturdy password")


async def test_create_org_for_an_existing_owner(run_cli, container):
    await container.users.create(email="walt@example.com", password="a sturdy password")

    code, out, _ = await run_cli(
        "create-org", "--name", "Vandelay", "--owner-email", "walt@example.com"
    )

    assert code == 0
    created = json.loads(out)
    assert created["slug"] == "vandelay"
    orgs = await container.organizations.get(__import__("uuid").UUID(created["id"]))
    assert orgs.name == "Vandelay"


async def test_errors_are_reported_without_a_traceback(run_cli):
    code, _, err = await run_cli(
        "create-org", "--name", "Nobody", "--owner-email", "ghost@example.com"
    )

    assert code == 1
    assert err.startswith("error: no user with the email")


async def test_short_passwords_are_refused(run_cli):
    code, _, err = await run_cli(
        "create-user", "--email", "xena@example.com", "--password-stdin", stdin="short\n"
    )

    assert code == 1
    assert "at least" in err
