"""The source systems the warehouse is fed from, declared in code.

A source names a file format, the columns its exports must have, how its timestamps are read
(IANA zone, DST policy, formats) and how far back each incremental run looks for late rows.
Each source feeds one dataset; the pipeline binds datasets to their normaliser and loader.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field
from datetime import timedelta
from enum import StrEnum
from zoneinfo import ZoneInfo

from etl.domain.money import DecimalSeparator
from etl.domain.timestamps import AmbiguousTimePolicy, load_zone
from etl.errors import UnknownSource


class Dataset(StrEnum):
    ORDERS = "orders"
    CUSTOMERS = "customers"
    PRODUCTS = "products"


@dataclass(frozen=True, slots=True)
class CsvFormat:
    delimiter: str
    decimal_separator: DecimalSeparator
    # "utf-8-sig" reads files with or without a byte-order mark.
    encoding: str = "utf-8"
    quotechar: str = '"'

    def __post_init__(self) -> None:
        if len(self.delimiter) != 1 or len(self.quotechar) != 1:
            raise ValueError("delimiter and quotechar must be single characters")
        if self.delimiter == self.decimal_separator:
            raise ValueError("the delimiter cannot be the decimal separator")


@dataclass(frozen=True, slots=True)
class JsonLinesFormat:
    encoding: str = "utf-8"


FileFormat = CsvFormat | JsonLinesFormat


@dataclass(frozen=True, slots=True)
class SourceSpec:
    name: str
    dataset: Dataset
    file_format: FileFormat
    required_columns: tuple[str, ...]
    optional_columns: tuple[str, ...] = ()
    # Zone of naive timestamps; timestamps with an explicit offset keep their offset.
    zone: str = "UTC"
    ambiguous_times: AmbiguousTimePolicy = AmbiguousTimePolicy.REJECT
    # strptime formats of naive timestamps; empty means ISO 8601.
    timestamp_formats: tuple[str, ...] = ()
    # Rows with updated_at at or before (watermark - lookback) are skipped.
    lookback: timedelta = timedelta(hours=1)
    description: str = field(default="", compare=False)

    def __post_init__(self) -> None:
        load_zone(self.zone)
        if self.lookback < timedelta(0):
            raise ValueError(f"{self.name}: lookback must not be negative")
        overlap = set(self.required_columns) & set(self.optional_columns)
        if overlap:
            raise ValueError(f"{self.name}: columns both required and optional: {overlap}")

    @property
    def tz(self) -> ZoneInfo:
        return load_zone(self.zone)

    @property
    def columns(self) -> tuple[str, ...]:
        return self.required_columns + self.optional_columns


ORDERS = SourceSpec(
    name="orders",
    dataset=Dataset.ORDERS,
    file_format=CsvFormat(delimiter=";", decimal_separator=","),
    required_columns=(
        "order_id",
        "position",
        "customer_id",
        "status",
        "ordered_at",
        "updated_at",
        "country",
        "currency",
        "sku",
        "quantity",
        "unit_price",
    ),
    zone="Europe/Berlin",
    ambiguous_times=AmbiguousTimePolicy.EARLIER,
    timestamp_formats=("%d.%m.%Y %H:%M:%S", "%d.%m.%Y %H:%M"),
    lookback=timedelta(hours=6),
    description="Shop order export: one row per order line, local Berlin time",
)

CUSTOMERS = SourceSpec(
    name="customers",
    dataset=Dataset.CUSTOMERS,
    file_format=JsonLinesFormat(),
    required_columns=("customer_id", "updated_at"),
    optional_columns=("email", "full_name", "phone", "country", "marketing_opt_in"),
    zone="UTC",
    lookback=timedelta(hours=1),
    description="CRM customer export: JSON Lines, optionally gzip-compressed",
)

PRODUCTS = SourceSpec(
    name="products",
    dataset=Dataset.PRODUCTS,
    file_format=CsvFormat(delimiter=",", decimal_separator=".", encoding="utf-8-sig"),
    required_columns=("sku", "name", "price", "currency", "updated_at"),
    optional_columns=("category", "active"),
    zone="UTC",
    lookback=timedelta(hours=1),
    description="Catalogue export: UTF-8 CSV, with or without a byte-order mark",
)

SOURCES: Mapping[str, SourceSpec] = {spec.name: spec for spec in (ORDERS, CUSTOMERS, PRODUCTS)}


def get_source(name: str, sources: Mapping[str, SourceSpec] = SOURCES) -> SourceSpec:
    spec = sources.get(name)
    if spec is None:
        raise UnknownSource(name, list(sources))
    return spec
