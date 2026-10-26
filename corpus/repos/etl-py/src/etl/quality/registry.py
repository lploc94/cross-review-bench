"""The checks declared for each warehouse table."""

from __future__ import annotations

from collections.abc import Iterable
from decimal import Decimal

from sqlalchemy import Table

from etl.domain.contact import COUNTRY_CODES
from etl.domain.money import CURRENCIES
from etl.domain.records import ORDER_STATUSES
from etl.infra.tables import customers, order_lines, orders, products
from etl.quality.checks import (
    AcceptedValues,
    Check,
    NotNull,
    Referential,
    RowCountDelta,
    Severity,
    Unique,
)

DEFAULT_TOLERANCE = Decimal("0.5")

CHECKS: tuple[Check, ...] = (
    # products
    Unique(products, ("product_id",)),
    NotNull(products, "name"),
    AcceptedValues(products, "currency", CURRENCIES.keys()),
    RowCountDelta(products, DEFAULT_TOLERANCE),
    # customers (type 2: one current version per customer)
    Unique(customers, ("customer_id",), where=customers.c.is_current, label="unique_current"),
    AcceptedValues(customers, "country", COUNTRY_CODES, Severity.WARN),
    RowCountDelta(customers, DEFAULT_TOLERANCE, where=customers.c.is_current),
    # orders
    NotNull(orders, "customer_id"),
    AcceptedValues(orders, "status", ORDER_STATUSES),
    AcceptedValues(orders, "currency", CURRENCIES.keys()),
    Referential(orders, "customer_id", customers, "customer_id"),
    RowCountDelta(orders, DEFAULT_TOLERANCE),
    # order lines
    Referential(order_lines, "product_id", products, "product_id", Severity.WARN),
)


def checks_for(tables: Iterable[Table], checks: Iterable[Check] = CHECKS) -> list[Check]:
    """The checks on any of `tables`, in declaration order."""
    wanted = set(tables)
    return [check for check in checks if check.table in wanted]


def find_check(name: str, checks: Iterable[Check] = CHECKS) -> Check | None:
    return next((check for check in checks if check.name == name), None)
