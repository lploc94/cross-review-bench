"""Normalised records, one per accepted source row, ready for staging.

Every record carries the source line it came from (`line_no`) and the source system's
`updated_at` (UTC): together they decide which version of a natural key wins inside a batch.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from decimal import Decimal
from typing import Protocol

type VersionKey = tuple[str, datetime]
"""A natural key and an `updated_at`: one version of something a dataset writes as several
rows (the lines of an order), which is loaded whole or not at all."""


@dataclass(slots=True)
class RejectedGroups:
    """What a run's rejected rows say about the rows that must not be loaded without them.

    `versions`: the versions the rejected rows belong to, where their key and updated_at could
    be read. `keys`: natural keys of rejected rows whose version could not be read, so that no
    version of that key in the batch can be trusted to be complete.
    """

    versions: set[VersionKey] = field(default_factory=set)
    keys: set[str] = field(default_factory=set)


class Record(Protocol):
    @property
    def line_no(self) -> int: ...

    @property
    def updated_at(self) -> datetime: ...


@dataclass(frozen=True, slots=True)
class ProductRecord:
    line_no: int
    product_id: str
    name: str
    category: str | None
    list_price: Decimal
    currency: str
    active: bool
    updated_at: datetime


@dataclass(frozen=True, slots=True)
class CustomerRecord:
    line_no: int
    customer_id: str
    email: str | None
    full_name: str | None
    phone: str | None
    country: str | None
    marketing_opt_in: bool | None
    updated_at: datetime


@dataclass(frozen=True, slots=True)
class OrderLineRecord:
    """One line of an order. The order's own columns repeat on each of its lines."""

    line_no: int
    order_id: str
    position: int
    customer_id: str
    status: str
    country: str
    currency: str
    ordered_at: datetime
    updated_at: datetime
    product_id: str
    quantity: int
    unit_price: Decimal
    line_amount: Decimal


ORDER_STATUSES = ("placed", "paid", "shipped", "delivered", "returned", "cancelled")
"""Accepted order statuses. Sales reports leave out cancelled orders."""
