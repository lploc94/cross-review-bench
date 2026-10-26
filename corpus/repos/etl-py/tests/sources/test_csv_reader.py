from __future__ import annotations

import gzip

import pytest

from etl.errors import SchemaMismatch, SourceFormatError
from etl.sources.base import MalformedRow, SourceRow
from etl.sources.readers import open_reader
from etl.sources.registry import ORDERS, PRODUCTS
from tests.helpers.factories import (
    ORDER_HEADER,
    PRODUCT_HEADER,
    order_row,
    product_row,
    write_orders,
    write_products,
)
from tests.helpers.files import csv_text, write_csv_gz, write_text


def read_all(spec, path):
    with open_reader(spec, path) as items:
        return list(items)


def test_rows_carry_their_physical_line_numbers(tmp_path):
    path = write_orders(tmp_path, [order_row(order_id="O-1"), order_row(order_id="O-2")])

    items = read_all(ORDERS, path)

    assert [item.line_no for item in items] == [2, 3]
    assert isinstance(items[0], SourceRow)
    assert items[1].fields["order_id"] == "O-2"
    assert items[0].fields["unit_price"] == "12,50"


def test_a_quoted_line_break_reports_the_line_the_row_starts_on(tmp_path):
    path = write_products(
        tmp_path,
        [product_row(sku="A", name="Cup\nwith saucer"), product_row(sku="B"), product_row(sku="C")],
    )

    items = read_all(PRODUCTS, path)

    assert [(item.line_no, item.fields["sku"]) for item in items] == [(2, "A"), (4, "B"), (5, "C")]
    assert items[0].fields["name"] == "Cup\nwith saucer"


def test_rows_with_the_wrong_number_of_fields_are_malformed(tmp_path):
    header = ";".join(ORDER_HEADER)
    good = ";".join(str(value) for value in order_row().values())
    path = write_text(tmp_path / "orders.csv", f"{header}\n{good}\nO-9;1;C-1\n\n{good}\n")

    items = read_all(ORDERS, path)

    assert [type(item).__name__ for item in items] == ["SourceRow", "MalformedRow", "SourceRow"]
    malformed = items[1]
    assert isinstance(malformed, MalformedRow)
    assert malformed.line_no == 3
    assert malformed.reason == f"expected {len(ORDER_HEADER)} fields, found 3"
    assert malformed.payload == ["O-9", "1", "C-1"]
    assert items[2].line_no == 5


def test_a_missing_or_duplicated_column_is_a_schema_mismatch(tmp_path):
    header = [name for name in ORDER_HEADER if name != "currency"] + ["sku"]
    path = write_text(tmp_path / "orders.csv", ";".join(header) + "\n")

    with pytest.raises(SchemaMismatch) as caught:
        read_all(ORDERS, path)

    assert caught.value.missing == ["currency"]
    assert caught.value.duplicated == ["sku"]


def test_header_names_are_trimmed_and_case_insensitive_and_extra_columns_ignored(tmp_path):
    header = [f" {name.upper()} " for name in ORDER_HEADER] + ["channel"]
    values = [*order_row().values(), "web"]
    path = write_text(
        tmp_path / "orders.csv", ";".join(header) + "\n" + ";".join(map(str, values)) + "\n"
    )

    (item,) = read_all(ORDERS, path)

    assert item.fields["order_id"] == "O-1"
    assert item.fields["channel"] == "web"


@pytest.mark.parametrize("bom", [True, False])
def test_product_files_are_read_with_or_without_a_byte_order_mark(tmp_path, bom):
    path = write_products(tmp_path, [product_row()], bom=bom)

    (item,) = read_all(PRODUCTS, path)

    assert item.fields["sku"] == "SKU-1"


def test_a_byte_order_mark_in_a_plain_utf8_source_is_ignored_in_the_header(tmp_path):
    path = write_orders(tmp_path, [order_row()], bom=True)

    (item,) = read_all(ORDERS, path)

    assert item.fields["order_id"] == "O-1"


def test_gzip_files_are_detected_by_content(tmp_path):
    path = write_csv_gz(tmp_path / "orders.csv", ORDER_HEADER, [order_row(), order_row()])

    assert [item.line_no for item in read_all(ORDERS, path)] == [2, 3]


def test_a_truncated_gzip_file_fails_the_read(tmp_path):
    data = gzip.compress(("\n".join([";".join(ORDER_HEADER)] * 500)).encode())
    path = tmp_path / "orders.csv.gz"
    path.write_bytes(data[: len(data) // 2])

    with pytest.raises(SourceFormatError, match="gzip"):
        read_all(ORDERS, path)


def test_an_empty_file_has_no_header(tmp_path):
    path = write_text(tmp_path / "orders.csv", "")

    with pytest.raises(SourceFormatError, match="no header"):
        read_all(ORDERS, path)


def test_bytes_outside_the_encoding_fail_the_read_with_a_line_number(tmp_path):
    path = tmp_path / "orders.csv"
    path.write_bytes((";".join(ORDER_HEADER) + "\n").encode() + b"O-1;\xff\xfe\n")

    with pytest.raises(SourceFormatError, match="not valid utf-8") as caught:
        read_all(ORDERS, path)

    assert caught.value.line_no is not None


@pytest.mark.parametrize("compress", [False, True])
def test_bytes_outside_the_encoding_are_reported_on_their_physical_line(tmp_path, compress):
    # Every record spans two physical lines; record n starts on line 2 + 2n.
    rows = [product_row(sku=f"S-{n}", name=f"Cup\nwith saucer {n}") for n in range(1000)]
    rows[700] = product_row(sku="S-700", name="Cup\nwith BAD saucer")
    data = csv_text(PRODUCT_HEADER, rows, delimiter=",").encode().replace(b"BAD", b"\xff")
    path = tmp_path / "products.csv"
    path.write_bytes(gzip.compress(data) if compress else data)

    with pytest.raises(SourceFormatError, match="not valid utf-8") as caught:
        read_all(PRODUCTS, path)

    assert caught.value.line_no == 1403


@pytest.mark.parametrize("newline", ["\n", "\r\n", "\r"])
def test_every_line_break_convention_is_read_with_quoted_breaks_kept(tmp_path, newline):
    header = ",".join(PRODUCT_HEADER)
    first = f'A,"Cup{newline}with saucer",1.00,EUR,2026-03-01T09:00:00Z,kitchen,true'
    second = "B,Plate,2.00,EUR,2026-03-01T09:00:00Z,kitchen,true"
    text = newline.join([header, first, second]) + newline
    path = write_text(tmp_path / "products.csv", text, compress=True)

    items = read_all(PRODUCTS, path)

    assert [(item.line_no, item.fields["sku"]) for item in items] == [(2, "A"), (4, "B")]
    assert items[0].fields["name"] == f"Cup{newline}with saucer"


def test_broken_quoting_fails_the_read(tmp_path):
    header = ";".join(ORDER_HEADER)
    path = write_text(tmp_path / "orders.csv", f'{header}\n"O-1"x;1;C-1\n')

    with pytest.raises(SourceFormatError, match="line 2: broken CSV"):
        read_all(ORDERS, path)
