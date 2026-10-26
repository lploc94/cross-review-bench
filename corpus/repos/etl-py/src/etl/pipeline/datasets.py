"""Which normaliser and loader serve each dataset."""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any

from etl.domain.records import Record
from etl.load.base import Loader
from etl.load.customers import CustomersLoader
from etl.load.orders import OrdersLoader
from etl.load.products import ProductsLoader
from etl.sources.registry import Dataset
from etl.transform.normalise import (
    KeyOf,
    Normaliser,
    RefuseMalformed,
    VersionOf,
    normalise_customer,
    normalise_order_line,
    normalise_product,
    order_key,
    order_version,
    refuse_order_line,
)


@dataclass(frozen=True, slots=True)
class DatasetBinding[R: Record]:
    normalise: Normaliser[R]
    loader: Loader[R]
    # For datasets whose versions span several rows: the version of a rejected row, whose
    # other rows the loader then refuses too, or its key when the version cannot be read; and
    # the error that fails the run on a row the reader could not split (it may belong to any
    # version). Other datasets reject such rows and go on.
    version_of: VersionOf | None = None
    key_of: KeyOf | None = None
    refuse_malformed: RefuseMalformed | None = None


DATASETS: Mapping[Dataset, DatasetBinding[Any]] = {
    Dataset.ORDERS: DatasetBinding(
        normalise_order_line,
        OrdersLoader(),
        version_of=order_version,
        key_of=order_key,
        refuse_malformed=refuse_order_line,
    ),
    Dataset.CUSTOMERS: DatasetBinding(normalise_customer, CustomersLoader()),
    Dataset.PRODUCTS: DatasetBinding(normalise_product, ProductsLoader()),
}
