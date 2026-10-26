"""warehouse facts: orders and order lines

Revision ID: 0003
Revises: 0002
Create Date: 2026-09-14 09:20:00+00:00
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0003"
down_revision: str | None = "0002"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

TZ = sa.DateTime(timezone=True)
MONEY = sa.Numeric(18, 3)


def upgrade() -> None:
    op.create_table(
        "orders",
        sa.Column("order_id", sa.Text(), primary_key=True),
        sa.Column("customer_id", sa.Text(), nullable=False),
        sa.Column(
            "customer_key",
            sa.BigInteger(),
            sa.ForeignKey("warehouse.customers.customer_key"),
            nullable=True,
        ),
        sa.Column("status", sa.Text(), nullable=False),
        sa.Column("country", sa.String(2), nullable=False),
        sa.Column("currency", sa.String(3), nullable=False),
        sa.Column("total_amount", MONEY, nullable=False),
        sa.Column("ordered_at", TZ, nullable=False),
        sa.Column("updated_at", TZ, nullable=False),
        sa.Column("loaded_at", TZ, nullable=False),
        sa.Column("run_id", sa.BigInteger(), sa.ForeignKey("etl.runs.id"), nullable=False),
        schema="warehouse",
    )
    op.create_index("ix_orders_ordered_at", "orders", ["ordered_at"], schema="warehouse")
    op.create_index("ix_orders_customer_id", "orders", ["customer_id"], schema="warehouse")
    op.create_index("ix_orders_run_id", "orders", ["run_id"], schema="warehouse")

    op.create_table(
        "order_lines",
        sa.Column(
            "order_id",
            sa.Text(),
            sa.ForeignKey("warehouse.orders.order_id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("position", sa.Integer(), nullable=False),
        sa.Column("product_id", sa.Text(), nullable=False),
        sa.Column(
            "product_key",
            sa.BigInteger(),
            sa.ForeignKey("warehouse.products.product_key"),
            nullable=True,
        ),
        sa.Column("quantity", sa.Integer(), nullable=False),
        sa.Column("unit_price", MONEY, nullable=False),
        sa.Column("line_amount", MONEY, nullable=False),
        sa.PrimaryKeyConstraint("order_id", "position", name="order_lines_pkey"),
        sa.CheckConstraint("quantity > 0", name="ck_order_lines_quantity_positive"),
        schema="warehouse",
    )
    op.create_index("ix_order_lines_product_id", "order_lines", ["product_id"], schema="warehouse")


def downgrade() -> None:
    op.drop_table("order_lines", schema="warehouse")
    op.drop_table("orders", schema="warehouse")
