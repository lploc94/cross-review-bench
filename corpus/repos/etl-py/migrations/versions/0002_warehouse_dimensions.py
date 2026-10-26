"""warehouse dimensions: products (type 1) and customers (type 2)

Revision ID: 0002
Revises: 0001
Create Date: 2026-09-14 09:10:00+00:00
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0002"
down_revision: str | None = "0001"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

TZ = sa.DateTime(timezone=True)
MONEY = sa.Numeric(18, 3)


def upgrade() -> None:
    op.execute("CREATE SCHEMA IF NOT EXISTS warehouse")

    op.create_table(
        "products",
        sa.Column("product_key", sa.BigInteger(), sa.Identity(), primary_key=True),
        sa.Column("product_id", sa.Text(), nullable=False),
        sa.Column("name", sa.Text(), nullable=False),
        sa.Column("category", sa.Text(), nullable=True),
        sa.Column("list_price", MONEY, nullable=False),
        sa.Column("currency", sa.String(3), nullable=False),
        sa.Column("active", sa.Boolean(), nullable=False),
        sa.Column("updated_at", TZ, nullable=False),
        sa.Column("loaded_at", TZ, nullable=False),
        sa.Column("run_id", sa.BigInteger(), sa.ForeignKey("etl.runs.id"), nullable=False),
        sa.UniqueConstraint("product_id"),
        schema="warehouse",
    )

    op.create_table(
        "customers",
        sa.Column("customer_key", sa.BigInteger(), sa.Identity(), primary_key=True),
        sa.Column("customer_id", sa.Text(), nullable=False),
        sa.Column("email", sa.Text(), nullable=True),
        sa.Column("full_name", sa.Text(), nullable=True),
        sa.Column("phone", sa.Text(), nullable=True),
        sa.Column("country", sa.String(2), nullable=True),
        sa.Column("marketing_opt_in", sa.Boolean(), nullable=True),
        sa.Column("valid_from", TZ, nullable=False),
        sa.Column("valid_to", TZ, nullable=True),
        sa.Column("is_current", sa.Boolean(), nullable=False),
        sa.Column("updated_at", TZ, nullable=False),
        sa.Column("loaded_at", TZ, nullable=False),
        sa.Column("run_id", sa.BigInteger(), sa.ForeignKey("etl.runs.id"), nullable=False),
        sa.CheckConstraint("is_current = (valid_to IS NULL)", name="ck_customers_current_is_open"),
        sa.CheckConstraint(
            "valid_to IS NULL OR valid_to > valid_from", name="ck_customers_validity"
        ),
        schema="warehouse",
    )
    op.create_index(
        "uq_customers_current_customer_id",
        "customers",
        ["customer_id"],
        unique=True,
        schema="warehouse",
        postgresql_where=sa.text("is_current"),
    )
    op.create_index(
        "ix_customers_customer_id_valid_from",
        "customers",
        ["customer_id", "valid_from"],
        schema="warehouse",
    )


def downgrade() -> None:
    op.drop_table("customers", schema="warehouse")
    op.drop_table("products", schema="warehouse")
    op.execute("DROP SCHEMA IF EXISTS warehouse")
