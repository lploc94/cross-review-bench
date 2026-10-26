"""Raw source rows in each source's own conventions, with sensible defaults.

Orders are written like the shop exports them: `;` separated, decimal comma, Berlin wall-clock
times as dd.mm.yyyy hh:mm:ss. Customers are JSON objects; products are `,` separated CSV with a
`.` decimal point.
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping, Sequence
from pathlib import Path
from typing import Any

from etl.sources.registry import CUSTOMERS, ORDERS, PRODUCTS
from tests.helpers.files import write_csv, write_jsonl

ORDER_HEADER = ORDERS.required_columns
PRODUCT_HEADER = (*PRODUCTS.required_columns, *PRODUCTS.optional_columns)
CUSTOMER_KEYS = CUSTOMERS.columns


def order_row(**overrides: object) -> dict[str, object]:
    row: dict[str, object] = {
        "order_id": "O-1",
        "position": "1",
        "customer_id": "C-1",
        "status": "paid",
        "ordered_at": "02.03.2026 10:15:00",
        "updated_at": "02.03.2026 10:20:00",
        "country": "de",
        "currency": "EUR",
        "sku": "SKU-1",
        "quantity": "2",
        "unit_price": "12,50",
    }
    row.update(overrides)
    return row


def product_row(**overrides: object) -> dict[str, object]:
    row: dict[str, object] = {
        "sku": "SKU-1",
        "name": "Espresso cup",
        "price": "12.50",
        "currency": "EUR",
        "updated_at": "2026-03-01T09:00:00Z",
        "category": "kitchen",
        "active": "true",
    }
    row.update(overrides)
    return row


def customer_obj(**overrides: object) -> dict[str, Any]:
    obj: dict[str, Any] = {
        "customer_id": "C-1",
        "email": "  Ada.Example@Example.COM ",
        "full_name": "Ada Example",
        "phone": "030 1234567",
        "country": "de",
        "marketing_opt_in": True,
        "updated_at": "2026-03-01T08:00:00Z",
    }
    obj.update(overrides)
    return obj


def write_orders(
    directory: Path,
    rows: Iterable[Mapping[str, object] | Sequence[object]],
    name: str = "orders.csv",
    **kw: Any,
) -> Path:
    return write_csv(directory / name, ORDER_HEADER, rows, delimiter=";", **kw)


def write_products(
    directory: Path,
    rows: Iterable[Mapping[str, object] | Sequence[object]],
    name: str = "products.csv",
    **kw: Any,
) -> Path:
    return write_csv(directory / name, PRODUCT_HEADER, rows, delimiter=",", **kw)


def write_customers(
    directory: Path, objects: Iterable[object], name: str = "customers.jsonl", **kw: Any
) -> Path:
    return write_jsonl(directory / name, objects, **kw)
