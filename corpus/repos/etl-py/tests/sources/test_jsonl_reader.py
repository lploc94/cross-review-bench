from __future__ import annotations

import gzip
import json

import pytest

from etl.errors import SourceFileNotFound, SourceFormatError
from etl.sources.base import MalformedRow, SourceRow
from etl.sources.readers import open_reader
from etl.sources.registry import CUSTOMERS
from tests.helpers.factories import customer_obj, write_customers
from tests.helpers.files import write_jsonl_gz


def read_all(path):
    with open_reader(CUSTOMERS, path) as items:
        return list(items)


def test_reads_one_object_per_line_skipping_blank_lines(tmp_path):
    path = write_customers(
        tmp_path,
        [customer_obj(customer_id="C-1"), customer_obj(customer_id="C-2")],
        raw_lines={1: "   "},
    )

    items = read_all(path)

    assert [(item.line_no, item.fields["customer_id"]) for item in items] == [
        (1, "C-1"),
        (3, "C-2"),
    ]


def test_lines_that_are_not_json_objects_are_malformed(tmp_path):
    path = write_customers(
        tmp_path,
        [customer_obj(), [1, 2]],
        raw_lines={1: '{"customer_id": "C-9", ', 2: '{"customer_id": NaN}'},
    )

    items = read_all(path)

    assert [type(item).__name__ for item in items] == [
        "SourceRow",
        "MalformedRow",
        "MalformedRow",
        "MalformedRow",
    ]
    assert isinstance(items[1], MalformedRow)
    assert items[1].reason.startswith("invalid JSON")
    assert items[1].payload == '{"customer_id": "C-9",'
    assert items[2].reason == "invalid JSON: NaN is not valid JSON"
    assert items[3].reason == "not a JSON object"


def test_gzip_compressed_exports_are_read_transparently(tmp_path):
    path = write_jsonl_gz(tmp_path / "customers.jsonl.gz", [customer_obj(), customer_obj()])

    items = read_all(path)

    assert [item.line_no for item in items] == [1, 2]
    assert all(isinstance(item, SourceRow) for item in items)


def test_reading_is_lazy(tmp_path):
    # A damaged byte far down the file: the first rows are delivered before it is reached.
    path = write_customers(tmp_path, [customer_obj(customer_id=f"C-{n}") for n in range(2000)])
    path.write_bytes(path.read_bytes() + b'{"customer_id": "\xff"}\n')

    with open_reader(CUSTOMERS, path) as items:
        first = next(items)
        assert isinstance(first, SourceRow)
        assert first.fields["customer_id"] == "C-0"
        with pytest.raises(SourceFormatError, match="not valid utf-8"):
            list(items)


@pytest.mark.parametrize("compress", [False, True])
def test_bytes_outside_the_encoding_are_reported_on_their_physical_line(tmp_path, compress):
    lines = [json.dumps(customer_obj(customer_id=f"C-{n}")).encode() for n in range(2000)]
    lines[1500] = b'{"customer_id": "\xff"}'
    data = b"\n".join(lines) + b"\n"
    path = tmp_path / "customers.jsonl"
    path.write_bytes(gzip.compress(data) if compress else data)

    with pytest.raises(SourceFormatError, match="not valid utf-8") as caught:
        read_all(path)

    assert caught.value.line_no == 1501


def test_a_missing_file_is_reported(tmp_path):
    with pytest.raises(SourceFileNotFound), open_reader(CUSTOMERS, tmp_path / "nope.jsonl"):
        pass
