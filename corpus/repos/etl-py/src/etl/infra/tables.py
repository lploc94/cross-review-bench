"""SQLAlchemy Core descriptions of the tables the migrations create.

Migrations own the schema; these definitions mirror them for queries (a test compares the two).
Run bookkeeping lives in the `etl` schema, loaded data in the `warehouse` schema.
"""

from __future__ import annotations

from sqlalchemy import (
    BigInteger,
    Boolean,
    CheckConstraint,
    Column,
    DateTime,
    ForeignKey,
    Identity,
    Index,
    Integer,
    MetaData,
    Numeric,
    PrimaryKeyConstraint,
    String,
    Table,
    Text,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB

ETL_SCHEMA = "etl"
WAREHOUSE_SCHEMA = "warehouse"

metadata = MetaData()

TZ = DateTime(timezone=True)
# Money columns: up to 15 digits before the point, up to 3 minor units (BHD, KWD, ...).
MONEY = Numeric(18, 3)

# --- etl: run bookkeeping -------------------------------------------------------------------

runs = Table(
    "runs",
    metadata,
    Column("id", BigInteger, Identity(), primary_key=True),
    Column("source", Text, nullable=False),
    Column("path", Text, nullable=False),
    Column("status", Text, nullable=False),
    Column("started_at", TZ, nullable=False),
    Column("finished_at", TZ, nullable=True),
    Column("rows_read", Integer, nullable=False, server_default=text("0")),
    Column("rows_skipped", Integer, nullable=False, server_default=text("0")),
    Column("rows_loaded", Integer, nullable=False, server_default=text("0")),
    Column("rows_rejected", Integer, nullable=False, server_default=text("0")),
    Column("error", Text, nullable=True),
    CheckConstraint("status IN ('running', 'succeeded', 'failed')", name="ck_runs_status"),
    CheckConstraint(
        "(status = 'running') = (finished_at IS NULL)", name="ck_runs_finished_when_done"
    ),
    Index("ix_runs_source_started_at", "source", "started_at"),
    schema=ETL_SCHEMA,
)

watermarks = Table(
    "watermarks",
    metadata,
    Column("source", Text, primary_key=True),
    Column("high_water", TZ, nullable=False),
    Column("updated_at", TZ, nullable=False),
    schema=ETL_SCHEMA,
)

rejects = Table(
    "rejects",
    metadata,
    Column("id", BigInteger, Identity(), primary_key=True),
    Column(
        "run_id",
        BigInteger,
        ForeignKey("etl.runs.id", ondelete="CASCADE"),
        nullable=False,
    ),
    Column("source", Text, nullable=False),
    Column("line_no", Integer, nullable=False),
    Column("column_name", Text, nullable=True),
    Column("reason", Text, nullable=False),
    Column("payload", JSONB, nullable=True),
    Column("created_at", TZ, nullable=False),
    Index("ix_rejects_run_id_line_no", "run_id", "line_no"),
    # Retention (`etl rejects prune`) deletes by age: rejects keep raw rows with personal data.
    Index("ix_rejects_created_at", "created_at"),
    schema=ETL_SCHEMA,
)

check_results = Table(
    "check_results",
    metadata,
    Column("id", BigInteger, Identity(), primary_key=True),
    Column(
        "run_id",
        BigInteger,
        ForeignKey("etl.runs.id", ondelete="CASCADE"),
        nullable=False,
    ),
    Column("check_name", Text, nullable=False),
    Column("table_name", Text, nullable=False),
    Column("severity", Text, nullable=False),
    Column("passed", Boolean, nullable=False),
    Column("observed", Numeric, nullable=True),
    Column("details", Text, nullable=False),
    Column("checked_at", TZ, nullable=False),
    CheckConstraint("severity IN ('error', 'warn')", name="ck_check_results_severity"),
    Index("ix_check_results_check_name_run_id", "check_name", "run_id"),
    Index("ix_check_results_run_id", "run_id"),
    schema=ETL_SCHEMA,
)

# --- warehouse: dimensions ------------------------------------------------------------------

products = Table(
    "products",
    metadata,
    Column("product_key", BigInteger, Identity(), primary_key=True),
    Column("product_id", Text, nullable=False, unique=True),
    Column("name", Text, nullable=False),
    Column("category", Text, nullable=True),
    Column("list_price", MONEY, nullable=False),
    Column("currency", String(3), nullable=False),
    Column("active", Boolean, nullable=False),
    Column("updated_at", TZ, nullable=False),
    Column("loaded_at", TZ, nullable=False),
    Column("run_id", BigInteger, ForeignKey("etl.runs.id"), nullable=False),
    schema=WAREHOUSE_SCHEMA,
)

# Slowly changing dimension, type 2: one row per version of a customer. The current version
# has is_current and no valid_to; a version is valid over [valid_from, valid_to).
customers = Table(
    "customers",
    metadata,
    Column("customer_key", BigInteger, Identity(), primary_key=True),
    Column("customer_id", Text, nullable=False),
    Column("email", Text, nullable=True),
    Column("full_name", Text, nullable=True),
    Column("phone", Text, nullable=True),
    Column("country", String(2), nullable=True),
    Column("marketing_opt_in", Boolean, nullable=True),
    Column("valid_from", TZ, nullable=False),
    Column("valid_to", TZ, nullable=True),
    Column("is_current", Boolean, nullable=False),
    Column("updated_at", TZ, nullable=False),
    Column("loaded_at", TZ, nullable=False),
    Column("run_id", BigInteger, ForeignKey("etl.runs.id"), nullable=False),
    CheckConstraint("is_current = (valid_to IS NULL)", name="ck_customers_current_is_open"),
    CheckConstraint("valid_to IS NULL OR valid_to > valid_from", name="ck_customers_validity"),
    Index(
        "uq_customers_current_customer_id",
        "customer_id",
        unique=True,
        postgresql_where=text("is_current"),
    ),
    Index("ix_customers_customer_id_valid_from", "customer_id", "valid_from"),
    schema=WAREHOUSE_SCHEMA,
)

# --- warehouse: facts -----------------------------------------------------------------------

orders = Table(
    "orders",
    metadata,
    Column("order_id", Text, primary_key=True),
    Column("customer_id", Text, nullable=False),
    # The customer version current when the order was loaded; NULL when the customer was
    # unknown at that time (the referential check reports such orders).
    Column(
        "customer_key",
        BigInteger,
        ForeignKey("warehouse.customers.customer_key"),
        nullable=True,
    ),
    Column("status", Text, nullable=False),
    Column("country", String(2), nullable=False),
    Column("currency", String(3), nullable=False),
    Column("total_amount", MONEY, nullable=False),
    Column("ordered_at", TZ, nullable=False),
    Column("updated_at", TZ, nullable=False),
    Column("loaded_at", TZ, nullable=False),
    Column("run_id", BigInteger, ForeignKey("etl.runs.id"), nullable=False),
    Index("ix_orders_ordered_at", "ordered_at"),
    Index("ix_orders_customer_id", "customer_id"),
    Index("ix_orders_run_id", "run_id"),
    schema=WAREHOUSE_SCHEMA,
)

order_lines = Table(
    "order_lines",
    metadata,
    Column(
        "order_id",
        Text,
        ForeignKey("warehouse.orders.order_id", ondelete="CASCADE"),
        nullable=False,
    ),
    Column("position", Integer, nullable=False),
    Column("product_id", Text, nullable=False),
    Column(
        "product_key",
        BigInteger,
        ForeignKey("warehouse.products.product_key"),
        nullable=True,
    ),
    Column("quantity", Integer, nullable=False),
    Column("unit_price", MONEY, nullable=False),
    Column("line_amount", MONEY, nullable=False),
    PrimaryKeyConstraint("order_id", "position", name="order_lines_pkey"),
    CheckConstraint("quantity > 0", name="ck_order_lines_quantity_positive"),
    Index("ix_order_lines_product_id", "product_id"),
    schema=WAREHOUSE_SCHEMA,
)

ETL_TABLES = (runs, watermarks, rejects, check_results)
WAREHOUSE_TABLES = (products, customers, orders, order_lines)
