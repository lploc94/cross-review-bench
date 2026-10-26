"""Report rows and report summaries."""

from __future__ import annotations

from datetime import date
from decimal import Decimal
from pathlib import Path

from pydantic import BaseModel, ConfigDict


class ReportModel(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")


class DailySalesRow(ReportModel):
    day: date
    country: str
    currency: str
    orders: int
    revenue: Decimal


class CustomerCountRow(ReportModel):
    country: str | None
    customers: int


class DailySalesReport(ReportModel):
    first_day: date
    last_day: date
    zone: str
    rows: list[DailySalesRow]
    path: Path


class CustomerCountsReport(ReportModel):
    # The end of this calendar day in the reporting zone; None for the current state.
    as_of: date | None
    zone: str
    rows: list[CustomerCountRow]
    path: Path

    @property
    def total(self) -> int:
        return sum(row.customers for row in self.rows)
