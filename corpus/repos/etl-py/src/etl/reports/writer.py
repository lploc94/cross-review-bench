"""Report files: CSV with a header row, written atomically into the report directory."""

from __future__ import annotations

import csv
from collections.abc import Iterable, Sequence
from pathlib import Path
from typing import TextIO

from etl.domain.money import currency, format_amount
from etl.infra.fs import atomic_write_text
from etl.schemas.reports import CustomerCountRow, DailySalesRow

UNKNOWN_COUNTRY = "--"


def write_csv(path: Path, header: Sequence[str], rows: Iterable[Sequence[str]]) -> Path:
    def write(handle: TextIO) -> None:
        writer = csv.writer(handle, lineterminator="\n")
        writer.writerow(header)
        writer.writerows(rows)

    return atomic_write_text(path, write)


def daily_sales_cells(rows: Iterable[DailySalesRow]) -> list[list[str]]:
    return [
        [
            row.day.isoformat(),
            row.country,
            row.currency,
            str(row.orders),
            format_amount(row.revenue, currency(row.currency)),
        ]
        for row in rows
    ]


def customer_count_cells(rows: Iterable[CustomerCountRow]) -> list[list[str]]:
    return [[row.country or UNKNOWN_COUNTRY, str(row.customers)] for row in rows]
