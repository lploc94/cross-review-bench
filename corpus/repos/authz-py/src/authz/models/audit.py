"""The audit log."""

from __future__ import annotations

import uuid
from typing import Any

from sqlalchemy import BigInteger, ForeignKey, Identity, Index, Text, Uuid
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from authz.models.base import Base, Timestamp


class AuditEvent(Base):
    """Append-only: rows are inserted in the transaction of the change they record."""

    __tablename__ = "audit_events"
    # Scanned backwards, it serves the newest-first keyset pagination of one organisation's log.
    __table_args__ = (Index("ix_audit_events_org_id_created_at_id", "org_id", "created_at", "id"),)

    id: Mapped[int] = mapped_column(BigInteger, Identity(always=True), primary_key=True)
    org_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False
    )
    actor_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, nullable=True)
    action: Mapped[str] = mapped_column(Text, nullable=False)
    target_type: Mapped[str] = mapped_column(Text, nullable=False)
    target_id: Mapped[str | None] = mapped_column(Text, nullable=True)
    data: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False, default=dict)
    ip: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[Timestamp]
