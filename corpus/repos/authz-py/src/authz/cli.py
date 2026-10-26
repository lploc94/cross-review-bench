"""Administration commands: `python -m authz.cli <command> …`.

create-user  --email E [--name N] [--password-stdin]   create a user (prompts for the password)
create-org   --name N --owner-email E [--slug S]       create an organisation and its owner
"""

from __future__ import annotations

import argparse
import asyncio
import getpass
import json
import sys
from collections.abc import Sequence
from typing import TextIO

from authz.config import ConfigError, load_settings
from authz.container import Container, build_container
from authz.domain.principal import Actor
from authz.errors import DomainError
from authz.logging import configure_logging


class CommandError(Exception):
    """A problem the operator can fix; printed without a traceback."""


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="python -m authz.cli", description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)

    user = commands.add_parser("create-user", help="create a user")
    user.add_argument("--email", required=True)
    user.add_argument("--name", default="", help="display name")
    user.add_argument(
        "--password-stdin",
        action="store_true",
        help="read the password from the first line of standard input",
    )

    org = commands.add_parser("create-org", help="create an organisation")
    org.add_argument("--name", required=True)
    org.add_argument("--owner-email", required=True, help="an existing user, the first owner")
    org.add_argument("--slug", default=None)
    return parser


def read_password(args: argparse.Namespace, stdin: TextIO) -> str:
    if args.password_stdin:
        password = stdin.readline().rstrip("\r\n")
    else:
        password = getpass.getpass("Password: ")
        if getpass.getpass("Repeat password: ") != password:
            raise CommandError("the passwords do not match")
    if not password:
        raise CommandError("the password is empty")
    return password


async def create_user(
    container: Container, args: argparse.Namespace, stdin: TextIO
) -> dict[str, str]:
    password = read_password(args, stdin)
    user = await container.users.create(email=args.email, password=password, display_name=args.name)
    return {"id": str(user.id), "email": user.email}


async def create_org(container: Container, args: argparse.Namespace) -> dict[str, str]:
    owner = await container.users.get_by_email(args.owner_email)
    if owner is None:
        raise CommandError(f"no user with the email {args.owner_email}")
    created = await container.organizations.create(
        owner.id, name=args.name, slug=args.slug, actor=Actor.system()
    )
    org = created.organization
    return {"id": str(org.id), "name": org.name, "slug": org.slug, "owner_id": str(owner.id)}


async def run(args: argparse.Namespace, container: Container, stdin: TextIO) -> dict[str, str]:
    try:
        if args.command == "create-user":
            return await create_user(container, args, stdin)
        if args.command == "create-org":
            return await create_org(container, args)
        raise CommandError(f"unknown command {args.command}")
    finally:
        await container.aclose()


def main(
    argv: Sequence[str] | None = None,
    *,
    stdin: TextIO = sys.stdin,
    stdout: TextIO = sys.stdout,
    stderr: TextIO = sys.stderr,
    container: Container | None = None,
) -> int:
    args = build_parser().parse_args(argv)
    if container is None:
        try:
            settings = load_settings()
        except ConfigError as error:
            print(error, file=stderr)
            return 2
        configure_logging("warning", stream=stderr)
        container = build_container(settings)
    try:
        result = asyncio.run(run(args, container, stdin))
    except (CommandError, DomainError) as error:
        print(f"error: {error}", file=stderr)
        return 1
    print(json.dumps(result), file=stdout)
    return 0


if __name__ == "__main__":
    sys.exit(main())
