"""run bookkeeping: runs, watermarks, rejects, check results

Revision ID: 0001
Revises:
Create Date: 2026-09-14 09:00:00+00:00
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0001"
down_revision: str | None = None
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

TZ = sa.DateTime(timezone=True)


def upgrade() -> None:
    op.execute("CREATE SCHEMA IF NOT EXISTS etl")

    op.create_table(
        "runs",
        sa.Column("id", sa.BigInteger(), sa.Identity(), primary_key=True),
        sa.Column("source", sa.Text(), nullable=False),
        sa.Column("path", sa.Text(), nullable=False),
        sa.Column("status", sa.Text(), nullable=False),
        sa.Column("started_at", TZ, nullable=False),
        sa.Column("finished_at", TZ, nullable=True),
        sa.Column("rows_read", sa.Integer(), nullable=False, server_default=sa.text("0")),
        sa.Column("rows_skipped", sa.Integer(), nullable=False, server_default=sa.text("0")),
        sa.Column("rows_loaded", sa.Integer(), nullable=False, server_default=sa.text("0")),
        sa.Column("rows_rejected", sa.Integer(), nullable=False, server_default=sa.text("0")),
        sa.Column("error", sa.Text(), nullable=True),
        sa.CheckConstraint("status IN ('running', 'succeeded', 'failed')", name="ck_runs_status"),
        sa.CheckConstraint(
            "(status = 'running') = (finished_at IS NULL)", name="ck_runs_finished_when_done"
        ),
        schema="etl",
    )
    op.create_index("ix_runs_source_started_at", "runs", ["source", "started_at"], schema="etl")

    op.create_table(
        "watermarks",
        sa.Column("source", sa.Text(), primary_key=True),
        sa.Column("high_water", TZ, nullable=False),
        sa.Column("updated_at", TZ, nullable=False),
        schema="etl",
    )

    op.create_table(
        "rejects",
        sa.Column("id", sa.BigInteger(), sa.Identity(), primary_key=True),
        sa.Column(
            "run_id",
            sa.BigInteger(),
            sa.ForeignKey("etl.runs.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("source", sa.Text(), nullable=False),
        sa.Column("line_no", sa.Integer(), nullable=False),
        sa.Column("column_name", sa.Text(), nullable=True),
        sa.Column("reason", sa.Text(), nullable=False),
        sa.Column("payload", postgresql.JSONB(), nullable=True),
        sa.Column("created_at", TZ, nullable=False),
        schema="etl",
    )
    op.create_index("ix_rejects_run_id_line_no", "rejects", ["run_id", "line_no"], schema="etl")

    op.create_table(
        "check_results",
        sa.Column("id", sa.BigInteger(), sa.Identity(), primary_key=True),
        sa.Column(
            "run_id",
            sa.BigInteger(),
            sa.ForeignKey("etl.runs.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("check_name", sa.Text(), nullable=False),
        sa.Column("table_name", sa.Text(), nullable=False),
        sa.Column("severity", sa.Text(), nullable=False),
        sa.Column("passed", sa.Boolean(), nullable=False),
        sa.Column("observed", sa.Numeric(), nullable=True),
        sa.Column("details", sa.Text(), nullable=False),
        sa.Column("checked_at", TZ, nullable=False),
        sa.CheckConstraint("severity IN ('error', 'warn')", name="ck_check_results_severity"),
        schema="etl",
    )
    op.create_index(
        "ix_check_results_check_name_run_id",
        "check_results",
        ["check_name", "run_id"],
        schema="etl",
    )
    op.create_index("ix_check_results_run_id", "check_results", ["run_id"], schema="etl")


def downgrade() -> None:
    op.drop_table("check_results", schema="etl")
    op.drop_table("rejects", schema="etl")
    op.drop_table("watermarks", schema="etl")
    op.drop_table("runs", schema="etl")
    op.execute("DROP SCHEMA IF EXISTS etl")
