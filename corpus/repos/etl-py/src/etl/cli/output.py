"""Plain-text tables and JSON for command output."""

import json
from collections.abc import Sequence
from datetime import UTC, datetime
from typing import Any

import typer
from pydantic import BaseModel


def format_time(moment: datetime | None) -> str:
    if moment is None:
        return "-"
    return moment.astimezone(UTC).strftime("%Y-%m-%d %H:%M:%SZ")


def render_table(
    header: Sequence[str], rows: Sequence[Sequence[str]], *, right: Sequence[int] = ()
) -> str:
    """Columns padded to their widest cell; the columns at the `right` indexes are aligned
    right (numbers)."""
    widths = [len(name) for name in header]
    for row in rows:
        for index, cell in enumerate(row):
            widths[index] = max(widths[index], len(cell))

    def line(cells: Sequence[str]) -> str:
        padded = [
            cell.rjust(widths[index]) if index in right else cell.ljust(widths[index])
            for index, cell in enumerate(cells)
        ]
        return "  ".join(padded).rstrip()

    rule = "  ".join("-" * width for width in widths)
    return "\n".join([line(header), rule, *(line(row) for row in rows)])


def to_json(value: BaseModel | Sequence[BaseModel]) -> str:
    data: Any
    if isinstance(value, BaseModel):
        data = value.model_dump(mode="json")
    else:
        data = [item.model_dump(mode="json") for item in value]
    return json.dumps(data, indent=2, ensure_ascii=False)


def echo_json(value: BaseModel | Sequence[BaseModel]) -> None:
    typer.echo(to_json(value))
