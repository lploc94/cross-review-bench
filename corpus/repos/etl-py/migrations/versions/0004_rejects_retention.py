"""rejects: index on created_at for retention

Revision ID: 0004
Revises: 0003
Create Date: 2026-09-21 08:40:00+00:00
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0004"
down_revision: str | None = "0003"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_index("ix_rejects_created_at", "rejects", ["created_at"], schema="etl")


def downgrade() -> None:
    op.drop_index("ix_rejects_created_at", table_name="rejects", schema="etl")
