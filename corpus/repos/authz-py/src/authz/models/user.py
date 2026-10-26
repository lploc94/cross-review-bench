"""Users and their login sessions."""

from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import ForeignKey, Index, Text, Uuid, text
from sqlalchemy.orm import Mapped, mapped_column

from authz.models.base import Base, OptionalTimestamp, Timestamp, UuidPk


class User(Base):
    __tablename__ = "users"
    __table_args__ = (Index("uq_users_email_lower", text("lower(email)"), unique=True),)

    id: Mapped[UuidPk]
    email: Mapped[str] = mapped_column(Text, nullable=False)
    display_name: Mapped[str] = mapped_column(Text, nullable=False, default="")
    password_hash: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[Timestamp]
    updated_at: Mapped[Timestamp]
    disabled_at: Mapped[OptionalTimestamp]

    @property
    def is_active(self) -> bool:
        return self.disabled_at is None


class Session(Base):
    """A login on one device. Refresh tokens rotate inside it; revoking it ends them all."""

    __tablename__ = "sessions"
    __table_args__ = (Index("ix_sessions_user_id_created_at", "user_id", "created_at"),)

    id: Mapped[UuidPk]
    user_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    device_label: Mapped[str | None] = mapped_column(Text, nullable=True)
    ip: Mapped[str | None] = mapped_column(Text, nullable=True)
    user_agent: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[Timestamp]
    last_used_at: Mapped[Timestamp]
    expires_at: Mapped[Timestamp]
    revoked_at: Mapped[OptionalTimestamp]
    revoked_reason: Mapped[str | None] = mapped_column(Text, nullable=True)

    def is_active(self, now: datetime) -> bool:
        return self.revoked_at is None and now < self.expires_at


class RefreshToken(Base):
    """One opaque refresh token; only its SHA-256 is stored."""

    __tablename__ = "refresh_tokens"
    __table_args__ = (Index("ix_refresh_tokens_session_id", "session_id"),)

    id: Mapped[UuidPk]
    session_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("sessions.id", ondelete="CASCADE"), nullable=False
    )
    token_hash: Mapped[str] = mapped_column(Text, nullable=False, unique=True)
    created_at: Mapped[Timestamp]
    expires_at: Mapped[Timestamp]
    used_at: Mapped[OptionalTimestamp]
    replaced_by_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("refresh_tokens.id", ondelete="SET NULL"), nullable=True
    )
