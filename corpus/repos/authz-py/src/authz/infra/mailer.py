"""Outgoing email."""

from __future__ import annotations

import asyncio
import smtplib
from dataclasses import dataclass
from email.message import EmailMessage as MimeMessage
from typing import Protocol

from authz.logging import get_logger

log = get_logger(__name__)


@dataclass(frozen=True, slots=True)
class EmailMessage:
    to: str
    subject: str
    body: str
    # A label for logs and metrics, e.g. "invitation"; never the content.
    kind: str


class Mailer(Protocol):
    async def send(self, message: EmailMessage) -> None: ...


class LogMailer:
    """Development mailer: logs that a message was sent, without its body (it holds tokens)."""

    async def send(self, message: EmailMessage) -> None:
        log.info("email.sent", to=message.to, subject=message.subject, kind=message.kind)


@dataclass(frozen=True, slots=True)
class SmtpOptions:
    host: str
    port: int
    sender: str
    username: str | None = None
    password: str | None = None
    starttls: bool = True
    timeout_seconds: float = 10.0


class SmtpMailer:
    def __init__(self, options: SmtpOptions) -> None:
        self._options = options

    async def send(self, message: EmailMessage) -> None:
        mime = MimeMessage()
        mime["From"] = self._options.sender
        mime["To"] = message.to
        mime["Subject"] = message.subject
        mime.set_content(message.body)
        await asyncio.to_thread(self._deliver, mime)
        log.info("email.sent", to=message.to, subject=message.subject, kind=message.kind)

    def _deliver(self, mime: MimeMessage) -> None:
        options = self._options
        with smtplib.SMTP(options.host, options.port, timeout=options.timeout_seconds) as smtp:
            if options.starttls:
                smtp.starttls()
            if options.username and options.password:
                smtp.login(options.username, options.password)
            smtp.send_message(mime)
