"""Normalisers: one raw row of a source to one record of its dataset."""

from __future__ import annotations

from collections.abc import Callable

from etl.domain.money import currency, to_minor_units
from etl.domain.records import (
    ORDER_STATUSES,
    CustomerRecord,
    OrderLineRecord,
    ProductRecord,
    VersionKey,
)
from etl.errors import SourceFormatError
from etl.sources.base import MalformedRow, SourceRow
from etl.sources.registry import SourceSpec
from etl.transform.fields import FieldReader, RowRejected

type Normaliser[R] = Callable[[SourceRow, SourceSpec], R]
# The version a rejected row belongs to, for datasets that load a version's rows together;
# its natural key alone, for when that version cannot be read (SourceFormatError when the key
# cannot be read either); and the error for a row the reader could not split, which may
# belong to any version.
type VersionOf = Callable[[SourceRow, SourceSpec], VersionKey | None]
type KeyOf = Callable[[SourceRow, SourceSpec], str]
type RefuseMalformed = Callable[[MalformedRow], SourceFormatError]

MAX_QUANTITY = 1_000_000
MAX_POSITION = 10_000
ID_LENGTH = 64


def normalise_product(row: SourceRow, spec: SourceSpec) -> ProductRecord:
    fields = FieldReader(row, spec)
    code = fields.currency("currency")
    return ProductRecord(
        line_no=row.line_no,
        product_id=fields.text("sku", max_length=ID_LENGTH),
        name=fields.text("name"),
        category=fields.optional_text("category"),
        list_price=fields.amount("price", code),
        currency=code,
        active=bool(fields.boolean("active", default=True)),
        updated_at=fields.timestamp("updated_at"),
    )


def normalise_customer(row: SourceRow, spec: SourceSpec) -> CustomerRecord:
    fields = FieldReader(row, spec)
    country = fields.optional_country("country")
    return CustomerRecord(
        line_no=row.line_no,
        customer_id=fields.text("customer_id", max_length=ID_LENGTH),
        email=fields.email("email"),
        full_name=fields.optional_text("full_name"),
        phone=fields.phone("phone", country),
        country=country,
        marketing_opt_in=fields.boolean("marketing_opt_in", default=None),
        updated_at=fields.timestamp("updated_at"),
    )


def normalise_order_line(row: SourceRow, spec: SourceSpec) -> OrderLineRecord:
    fields = FieldReader(row, spec)
    code = fields.currency("currency")
    ordered_at = fields.timestamp("ordered_at")
    updated_at = fields.timestamp("updated_at")
    if updated_at < ordered_at:
        raise RowRejected("updated_at is before ordered_at", "updated_at")
    quantity = fields.integer("quantity", minimum=1, maximum=MAX_QUANTITY)
    unit_price = fields.amount("unit_price", code)
    try:
        line_amount = to_minor_units(unit_price * quantity, currency(code))
    except ValueError as error:
        raise RowRejected(f"line amount: {error}", "quantity") from None
    return OrderLineRecord(
        line_no=row.line_no,
        order_id=fields.text("order_id", max_length=ID_LENGTH),
        position=fields.integer("position", minimum=1, maximum=MAX_POSITION),
        customer_id=fields.text("customer_id", max_length=ID_LENGTH),
        status=fields.choice("status", ORDER_STATUSES),
        country=fields.country("country"),
        currency=code,
        ordered_at=ordered_at,
        updated_at=updated_at,
        product_id=fields.text("sku", max_length=ID_LENGTH),
        quantity=quantity,
        unit_price=unit_price,
        line_amount=line_amount,
    )


def order_key(row: SourceRow, spec: SourceSpec) -> str:
    """The order_id of an order line that was rejected and whose version cannot be read.

    Without a readable order_id (empty, too long, a NUL character) the line may belong to any
    order version in the file, and loading the others could replace a stored order with a part
    of it: SourceFormatError fails the run.
    """
    try:
        return FieldReader(row, spec).text("order_id", max_length=ID_LENGTH)
    except RowRejected:
        raise SourceFormatError(
            "an order line has no readable order_id", line_no=row.line_no
        ) from None


def refuse_order_line(row: MalformedRow) -> SourceFormatError:
    """The error for an order line the reader could not split into its fields.

    A stray or missing delimiter can fall anywhere, inside the order_id or next to it, so no
    field of such a line can be trusted to name its order. It may be a line of any order
    version in the file, and loading the others could replace a stored order with a part of
    it: the run fails instead.
    """
    return SourceFormatError(
        "an order line could not be split into its fields", line_no=row.line_no
    )


def order_version(row: SourceRow, spec: SourceSpec) -> VersionKey | None:
    """The order version (order_id, updated_at) of an order line that was rejected, when both
    can still be read: the other lines of that version must not be loaded without it."""
    fields = FieldReader(row, spec)
    try:
        return fields.text("order_id", max_length=ID_LENGTH), fields.timestamp("updated_at")
    except RowRejected:
        return None
